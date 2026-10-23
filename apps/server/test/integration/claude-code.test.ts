import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type {
  Agent,
  Attachment,
  PermissionRule,
  Project,
  ServerFrame,
  SessionUsage,
  UploadAttachmentsResponse,
} from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentToolContext } from '../../src/kernel/agent-tools.js';
import type { StudioModule } from '../../src/kernel/module.js';
import type {
  ClaudeCodeAdapter,
  RateLimitObserved,
} from '../../src/modules/claude-code/claude-code.module.js';
import {
  type ClaudeKit,
  STANDIN_BIN,
  createClaudeKit,
} from '../../src/modules/claude-code/testing/kit.js';
import { until } from '../../src/testing/agents-kit.js';

/**
 * The Claude Code adapter, driven end to end: the real module, the real
 * runtime, the real MCP bridge — and the stand-in CLI from
 * `tests/fixtures/bin` in place of the real `claude`.
 */

/** Two tools as another module would register them: one that only reads, one that changes something. */
const written: Array<{ context: AgentToolContext; input: unknown }> = [];
const toolsModule: StudioModule = {
  name: 'testing.claude-tools',
  setup(context) {
    context.agentTools.register({
      name: 'whoami',
      description: 'Says which run is calling.',
      input: z.object({}),
      effect: 'read',
      handler: ({ signal, ...identity }) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return { text: JSON.stringify(identity) };
      },
    });
    context.agentTools.register({
      name: 'note_write',
      description: 'Writes a note.',
      input: z.object({ title: z.string().min(1), body: z.string() }),
      effect: 'write',
      handler: (toolContext, input) => {
        written.push({ context: toolContext, input });
        return { text: `saved "${input.title}"` };
      },
    });
  },
};

let c: ClaudeKit;
let projectDir: string;
beforeAll(async () => {
  c = await createClaudeKit({ extraModules: [toolsModule] });
  projectDir = c.kit.project.rootDir;
});
afterAll(async () => {
  await c.close();
});

const adapter = (): ClaudeCodeAdapter =>
  c.kit.t.studio.context.services.agents.adapter('claude-code') as ClaudeCodeAdapter;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function upload(
  sessionId: string,
  files: Array<{ name: string; type: string; content: Buffer | string }>,
): Promise<Attachment[]> {
  const boundary = `----claude-test-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\ncontent-disposition: form-data; name="files"; filename="${file.name}"\r\ncontent-type: ${file.type}\r\n\r\n`,
      ),
      typeof file.content === 'string' ? Buffer.from(file.content) : file.content,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  const response = await c.owner.request<UploadAttachmentsResponse>(
    'POST',
    `/api/sessions/${sessionId}/attachments`,
    Buffer.concat(chunks),
    {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
  );
  if (response.status !== 201) throw new Error(`Upload failed: ${JSON.stringify(response.body)}`);
  return response.body.attachments;
}

describe('status and capabilities', () => {
  it("reports the installed CLI, its version and the signed-in account from the CLI's own status command", async () => {
    const agent = (await c.owner.get<Agent>('/api/agents/claude-code')).body;
    expect(agent).toMatchObject({ id: 'claude-code', displayName: 'Claude Code', kind: 'cli' });
    expect(agent.status).toEqual({
      installed: true,
      version: '2.1.283-standin',
      signedIn: true,
      account: 'standin@example.test (max)',
      problem: null,
    });
  });

  it('offers the CLI\'s model aliases and effort levels, with "default" meaning the CLI\'s own choice', async () => {
    const { capabilities } = (await c.owner.get<Agent>('/api/agents/claude-code')).body;
    expect(capabilities.models.map((model) => model.id)).toEqual([
      'default',
      'fable',
      'opus',
      'sonnet',
      'haiku',
    ]);
    expect(capabilities.defaultModel).toBe('default');
    // Aliases, never dated model ids.
    expect(capabilities.models.every((model) => !/\d{6,}/.test(model.id))).toBe(true);
    expect(capabilities.models[0]).toMatchObject({
      recommended: true,
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    });
    expect(capabilities).toMatchObject({
      permissionModes: ['plan', 'ask', 'accept-edits', 'auto'],
      images: true,
      steering: true,
      resume: true,
      planMode: true,
      usage: true,
    });
  });

  it('says that the sign-in launcher is the fix when the CLI is signed out', async () => {
    c.signedIn(false);
    adapter().cli.forget();
    try {
      const status = await adapter().status();
      expect(status).toMatchObject({
        installed: true,
        version: '2.1.283-standin',
        signedIn: false,
        account: null,
      });
      expect(status.problem).toMatch(/not signed in/i);
      expect(status.problem).toContain('claude-login');
    } finally {
      c.signedIn(true);
      adapter().cli.forget();
    }
  });

  it('keeps the answer for a while instead of asking the CLI every time', async () => {
    adapter().cli.forget();
    const first = await adapter().status();
    c.signedIn(false);
    try {
      expect(await adapter().status()).toEqual(first);
    } finally {
      c.signedIn(true);
      adapter().cli.forget();
    }
  });
});

describe('a turn', () => {
  it('the stand-in accepts only exact boolean fast-mode settings and rejects other settings', async () => {
    const processes = c.kit.t.studio.context.processes;
    const runSettings = (value: string) =>
      processes.run(
        path.join(STANDIN_BIN, 'claude'),
        [
          '--print',
          '--verbose',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--settings',
          value,
        ],
        {
          env: processes.env({ HOME: c.home }),
          input:
            JSON.stringify({
              type: 'user',
              message: { role: 'user', content: 'settings validation' },
            }) + '\n',
          timeoutMs: 5000,
          maxOutputBytes: 16000,
        },
      );
    for (const fastMode of [true, false])
      expect((await runSettings(JSON.stringify({ fastMode }))).code).toBe(0);
    for (const invalid of [
      '{}',
      '{"fastMode":"true"}',
      '{"fastMode":true,"permissions":{"defaultMode":"bypassPermissions"}}',
      '{"permissions":{"allow":["Bash"]}}',
      '/tmp/untrusted-settings.json',
      'null',
    ]) {
      expect((await runSettings(invalid)).code).toBe(1);
    }
  });

  it('streams the answer, then stores it once — the same block, not a second copy', async () => {
    const session = await c.session();
    const live = await c.kit.connect(c.owner);
    await live.subscribe(`session:${session.id}`);
    const run = await c.turn(session.id, 'hello there');
    expect(run).toMatchObject({ status: 'completed', error: null });
    await live.next((frame) => frame.op === 'event' && frame.type === 'run.finished');

    const frames: Array<Extract<ServerFrame, { op: 'event' }>> = live.events(
      `session:${session.id}`,
    );
    const deltas = frames
      .filter((event) => event.type === 'message.delta')
      .map((event) => event.data as { messageId: string; offset: number; text: string });
    const stored = await c.eventsOf(session.id, 'message.assistant');
    const answer =
      'You said: “hello there”. This is the Claude Code stand-in; message 1 of this conversation.';
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      text: answer,
      model: 'claude-opus-standin',
      parentToolCallId: null,
      partial: false,
    });

    // The deltas belong to the same block, arrive in order and add up to exactly the stored text.
    expect(deltas.length).toBeGreaterThan(3);
    expect(new Set(deltas.map((delta) => delta.messageId))).toEqual(
      new Set([stored[0]!.messageId]),
    );
    let length = 0;
    for (const delta of deltas) {
      expect(delta.offset).toBe(length);
      length += delta.text.length;
    }
    expect(deltas.map((delta) => delta.text).join('')).toBe(answer);

    // Order of the durable log: the message, the run, its answer, usage, and one terminal event.
    const types = (await c.events(session.id)).map((event) => event.type);
    expect(types).toEqual([
      'message.user',
      'run.started',
      'message.assistant',
      'usage.reported',
      'usage.reported',
      'run.finished',
    ]);
    // The live stream ends with the same terminal event, and the completed block came after the last delta.
    const order = frames.map((event) => event.type);
    expect(order.lastIndexOf('message.delta')).toBeLessThan(order.indexOf('message.assistant'));
    expect(order.filter((type) => type === 'run.finished')).toHaveLength(1);
    // An empty reasoning block (models that keep their reasoning to themselves) is not shown.
    expect(await c.eventsOf(session.id, 'thinking')).toEqual([]);
    live.close();
  });

  it("records the CLI's conversation id on the server and never shows it", async () => {
    const session = await c.session();
    await c.turn(session.id, 'remember me');
    const nativeId = await c.nativeId(session.id);
    expect(nativeId).toMatch(/^[0-9a-f-]{36}$/);
    const visible = JSON.stringify([
      await c.events(session.id),
      await c.kit.state(c.owner, session.id),
      (await c.owner.get(`/api/sessions/${session.id}`)).body,
    ]);
    expect(visible).not.toContain(nativeId!);
    expect(
      (await c.owner.get<{ resumable: boolean }>(`/api/sessions/${session.id}`)).body.resumable,
    ).toBe(true);
  });

  it('starts the CLI in its machine-readable mode, isolated from user and project settings, with prompts routed to the Studio', async () => {
    const session = await c.session();
    await c.turn(session.id, 'how are you started?');
    const invocation = c.lastInvocation();
    const { argv } = invocation;
    expect(invocation.cwd).toBe(projectDir);
    expect(argv.slice(0, 7)).toEqual([
      '--print',
      '--verbose',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
    ]);
    expect(argv).toContain('--replay-user-messages');
    expect(c.argOf(invocation, '--permission-mode')).toBe('manual');
    expect(c.argOf(invocation, '--permission-prompt-tool')).toBe('mcp__studio__permission_prompt');
    expect(argv).toContain('--strict-mcp-config');
    expect(c.argOf(invocation, '--setting-sources')).toBe('');
    // "default" is the CLI's own choice: no model is named, and nothing is resumed on a first turn.
    expect(argv).not.toContain('--model');
    expect(argv).not.toContain('--resume');
    expect(argv).not.toContain('--effort');
    // The prompt travels on standard input, never on the command line.
    expect(argv.join('\n')).not.toContain('how are you started?');
    // The only explicit setting controls speed; permission settings are not allowed.
    expect(JSON.parse(c.argOf(invocation, '--settings')!)).toEqual({ fastMode: false });
    // Nothing that would let the CLI skip a prompt.
    for (const forbidden of [
      '--dangerously-skip-permissions',
      '--allow-dangerously-skip-permissions',
      'bypassPermissions',
      'acceptEdits',
      'dontAsk',
      '--allowedTools',
      '--allowed-tools',
    ]) {
      expect(argv).not.toContain(forbidden);
    }
  });

  it('passes the chosen model and effort, a free-form model id included', async () => {
    const session = await c.session({ model: 'haiku', effort: 'high' });
    await c.turn(session.id, 'quick one');
    let invocation = c.lastInvocation();
    expect(c.argOf(invocation, '--model')).toBe('haiku');
    expect(c.argOf(invocation, '--effort')).toBe('high');
    expect((await c.eventsOf(session.id, 'message.assistant'))[0]!.model).toBe(
      'claude-haiku-standin',
    );

    await c.turn(session.id, 'and another', { model: 'claude-custom-9', effort: 'ludicrous' });
    invocation = c.lastInvocation();
    expect(c.argOf(invocation, '--model')).toBe('claude-custom-9');
    // An effort level this CLI does not have is left out, and the user is told.
    expect(invocation.argv).not.toContain('--effort');
    expect(await c.eventsOf(session.id, 'notice')).toEqual([
      expect.objectContaining({ level: 'info', code: 'effort_ignored' }),
    ]);
  });

  it('appends the shared-memory conventions to the system prompt, and nothing when assistants may not use memory', async () => {
    const session = await c.session();
    await c.turn(session.id, 'first');
    const guide = c.kit.t.studio.context.services.memory.agentGuide();
    expect(guide).toMatch(/Shared memory/);
    expect(c.argOf(c.lastInvocation(), '--append-system-prompt')).toBe(guide);

    expect((await c.owner.put('/api/memory/settings', { agentAccess: false })).status).toBe(200);
    try {
      await c.turn(session.id, 'second');
      expect(c.lastInvocation().argv).not.toContain('--append-system-prompt');
    } finally {
      await c.owner.put('/api/memory/settings', { agentAccess: true });
    }
  });

  it('shows reasoning when the model shares it', async () => {
    const session = await c.session();
    await c.turn(session.id, '[[scenario:thinking]]');
    expect(await c.eventsOf(session.id, 'thinking')).toEqual([
      expect.objectContaining({ text: 'Two plus two: that is four.', partial: false }),
    ]);
    expect(await c.texts(session.id)).toEqual(['The answer is 4.']);
  });

  it('reports usage per model with cost, the context window and how full it is', async () => {
    const session = await c.session();
    const run = await c.turn(session.id, '[[scenario:bash pwd]]');
    const reports = await c.eventsOf(session.id, 'usage.reported');
    const last = reports[reports.length - 1]!;
    // Two model requests: the tool call and the closing sentence. The last report is the CLI's own total.
    expect(last).toMatchObject({
      runId: run.id,
      model: 'claude-opus-standin',
      inputTokens: 24,
      cacheWriteTokens: 400,
      cacheReadTokens: 5300 + 5600,
      contextWindow: 200_000,
    });
    expect(last.costUsd).toBeGreaterThan(0);
    // The context figure is that of the newest request: what was sent plus what came back.
    expect(last.contextTokens).toBeGreaterThan(5600);
    expect(last.contextTokens).toBeLessThan(6100);
    // Totals only ever grow within a run.
    for (let at = 1; at < reports.length; at += 1)
      expect(reports[at]!.outputTokens).toBeGreaterThanOrEqual(reports[at - 1]!.outputTokens);

    const usage = (await c.owner.get<SessionUsage>(`/api/sessions/${session.id}/usage`)).body;
    expect(usage.context).toMatchObject({
      tokens: last.contextTokens,
      window: 200_000,
      model: 'claude-opus-standin',
    });
    expect(usage.totals).toEqual([
      expect.objectContaining({
        model: 'claude-opus-standin',
        inputTokens: 24,
        outputTokens: last.outputTokens,
        costUsd: last.costUsd,
      }),
    ]);
  });
});

describe('usage over several turns', () => {
  it('reports only what each run used, although the CLI totals a conversation across resumes', async () => {
    const session = await c.session();
    const runs = [await c.turn(session.id, 'one'), await c.turn(session.id, 'two')];
    const lastReport = async (runId: string) =>
      (await c.eventsOf(session.id, 'usage.reported'))
        .filter((report) => report.runId === runId)
        .at(-1)!;
    const [first, second] = [await lastReport(runs[0]!.id), await lastReport(runs[1]!.id)];
    // The stand-in, like the real CLI, printed conversation totals with the second result (24 input tokens,
    // twice the cost). The second run is recorded with its own share only.
    expect(first).toMatchObject({
      inputTokens: 12,
      cacheWriteTokens: 200,
      cacheReadTokens: 5300,
      contextWindow: 200_000,
    });
    expect(second).toMatchObject({
      inputTokens: 12,
      cacheWriteTokens: 200,
      cacheReadTokens: 5300,
      contextWindow: 200_000,
    });
    expect(first.costUsd).toBeCloseTo(0.0055, 3);
    expect(second.costUsd).toBeCloseTo(0.0055, 3);
    let usage = (await c.owner.get<SessionUsage>(`/api/sessions/${session.id}/usage`)).body;
    expect(usage.totals).toEqual([
      expect.objectContaining({
        inputTokens: 24,
        cacheWriteTokens: 400,
        costUsd: expect.closeTo(first.costUsd! + second.costUsd!, 6),
      }),
    ]);

    // After a restart of the server nobody remembers where the conversation stood: the next run reports
    // the tokens it saw and no cost, rather than a cost that counts the earlier turns again…
    adapter().forgetUsage();
    const third = await lastReport((await c.turn(session.id, 'three')).id);
    expect(third).toMatchObject({
      inputTokens: 12,
      cacheWriteTokens: 200,
      costUsd: null,
      contextWindow: 200_000,
    });
    // …and the one after that is exact again.
    const fourth = await lastReport((await c.turn(session.id, 'four')).id);
    expect(fourth).toMatchObject({ inputTokens: 12, cacheWriteTokens: 200 });
    expect(fourth.costUsd).toBeCloseTo(0.0055, 3);
    usage = (await c.owner.get<SessionUsage>(`/api/sessions/${session.id}/usage`)).body;
    expect(usage.totals[0]).toMatchObject({ inputTokens: 48, cacheWriteTokens: 800 });
    expect(usage.totals[0]!.costUsd).toBeCloseTo(
      first.costUsd! + second.costUsd! + fourth.costUsd!,
      6,
    );
  });
});

describe('permission prompts', () => {
  it('puts a file edit to the user and carries it out when allowed', async () => {
    const session = await c.session();
    const sent = await c.send(session.id, '[[scenario:edit-file notes/first.txt]]');
    const approval = await c.pendingApproval(session.id);
    const file = path.join(projectDir, 'notes/first.txt');
    expect(approval).toMatchObject({
      kind: 'tool',
      toolName: 'Write',
      toolKind: 'edit',
      title: 'Write notes/first.txt',
      paths: [file],
      command: null,
      risk: 'medium',
      status: 'pending',
    });
    expect(approval.diff).toContain('+written by the stand-in');
    expect(approval.input).toEqual({ file_path: file, content: 'written by the stand-in\n' });
    // Nothing has been written while the question is open.
    expect(existsSync(file)).toBe(false);

    // The call is in the transcript before the question about it.
    const before = await c.events(session.id);
    const started = before.find((event) => event.type === 'tool.started')!;
    const requested = before.find((event) => event.type === 'approval.requested')!;
    expect(started.data).toMatchObject({
      toolCallId: approval.toolCallId,
      name: 'Write',
      kind: 'edit',
      title: 'Write notes/first.txt',
      parentToolCallId: null,
    });
    expect(started.seq).toBeLessThan(requested.seq);

    expect((await c.decide(approval.id, { decision: 'allow' })).status).toBe(200);
    const run = await c.runEnded(sent.body.runId!);
    expect(run.status).toBe('completed');
    expect(readFileSync(file, 'utf8')).toBe('written by the stand-in\n');
    const finished = (await c.eventsOf(session.id, 'tool.finished'))[0]!;
    expect(finished).toMatchObject({ toolCallId: approval.toolCallId, status: 'ok' });
    expect(finished.output).toContain('File created successfully');
    expect(finished.diffs).toEqual([
      {
        path: 'notes/first.txt',
        added: 1,
        removed: 0,
        patch: '--- /dev/null\n+++ b/notes/first.txt\n@@ -0,0 +1,1 @@\n+written by the stand-in\n',
      },
    ]);
    expect(await c.texts(session.id)).toEqual(['The file notes/first.txt is written.']);
  });

  it('reports a refusal as denied, hands the reason to the agent, and lets the turn finish', async () => {
    const session = await c.session();
    const sent = await c.send(session.id, '[[scenario:edit-file refused.txt]]');
    const approval = await c.pendingApproval(session.id);
    await c.decide(approval.id, { decision: 'deny', note: 'Not that file, please.' });
    const run = await c.runEnded(sent.body.runId!);
    expect(run).toMatchObject({ status: 'completed', error: null });
    expect(existsSync(path.join(projectDir, 'refused.txt'))).toBe(false);
    expect(await c.eventsOf(session.id, 'tool.finished')).toEqual([
      expect.objectContaining({
        toolCallId: approval.toolCallId,
        status: 'denied',
        output: 'Not that file, please.',
        diffs: [],
      }),
    ]);
    expect(await c.texts(session.id)).toEqual([
      'I could not write refused.txt: Not that file, please.',
    ]);
  });

  it('asks about a command with its exact command line, and not again once the user said "always"', async () => {
    const session = await c.session();
    const sent = await c.send(session.id, '[[scenario:bash npm run lint]]');
    const approval = await c.pendingApproval(session.id);
    expect(approval).toMatchObject({
      kind: 'tool',
      toolName: 'Bash',
      toolKind: 'execute',
      title: 'Run npm run lint',
      command: 'npm run lint',
    });
    expect(approval.suggestedRule).toEqual({ tool: 'Bash', pattern: 'npm run lint *' });
    const decided = await c.decide(approval.id, { decision: 'allow', remember: 'session' });
    expect((decided.body as { rule: PermissionRule }).rule).toMatchObject({
      scope: 'session',
      effect: 'allow',
      tool: 'Bash',
      pattern: 'npm run lint *',
    });
    await c.runEnded(sent.body.runId!);
    expect(await c.eventsOf(session.id, 'tool.finished')).toEqual([
      expect.objectContaining({ status: 'ok', output: 'stand-in ran: npm run lint' }),
    ]);

    // The CLI asks again — it always does — and the engine answers from the saved rule without a person.
    const second = await c.turn(session.id, '[[scenario:bash npm run lint]]');
    expect(second.status).toBe('completed');
    expect(await c.eventsOf(session.id, 'approval.requested')).toHaveLength(1);
    expect((await c.eventsOf(session.id, 'tool.finished')).map((event) => event.status)).toEqual([
      'ok',
      'ok',
    ]);
  });

  it("lets the engine, not the CLI, apply the session's mode: edits run unasked in accept-edits, commands still ask", async () => {
    const session = await c.session({ permissionMode: 'accept-edits' });
    const edited = await c.turn(session.id, '[[scenario:edit-file notes/first.txt]]');
    expect(edited.status).toBe('completed');
    // The CLI itself is in its asking mode all the same.
    expect(c.argOf(c.lastInvocation(), '--permission-mode')).toBe('manual');
    expect(await c.eventsOf(session.id, 'approval.requested')).toEqual([]);
    // The file existed already (an earlier test wrote it): the result carries a real patch.
    expect((await c.eventsOf(session.id, 'tool.finished'))[0]).toMatchObject({
      status: 'ok',
      diffs: [
        {
          path: 'notes/first.txt',
          added: 1,
          removed: 1,
          patch:
            '--- a/notes/first.txt\n+++ b/notes/first.txt\n@@ -1,1 +1,1 @@\n-written by the stand-in\n+written by the stand-in\n',
        },
      ],
    });

    const sent = await c.send(session.id, '[[scenario:bash rm -rf build]]');
    const approval = await c.pendingApproval(session.id);
    expect(approval).toMatchObject({ toolName: 'Bash', command: 'rm -rf build' });
    await c.decide(approval.id, { decision: 'deny' });
    await c.runEnded(sent.body.runId!);
  });

  it('denies instead of waiting when nobody is watching the run', async () => {
    const session = await c.session();
    const agents = c.kit.t.studio.context.services.agents;
    const receipt = await agents.sendMessage(
      agents.principalFor(c.owner.userId!)!,
      session.id,
      { requestId: `scheduled-${Date.now()}`, text: '[[scenario:edit-file unattended.txt]]' },
      { origin: 'scheduled' },
    );
    const run = await c.runEnded(receipt.runId!);
    expect(run).toMatchObject({ status: 'completed', unattended: true });
    expect(existsSync(path.join(projectDir, 'unattended.txt'))).toBe(false);
    expect(await c.eventsOf(session.id, 'approval.requested')).toEqual([]);
    expect(await c.eventsOf(session.id, 'tool.finished')).toEqual([
      expect.objectContaining({ status: 'denied' }),
    ]);
    expect(await c.eventsOf(session.id, 'notice')).toEqual([
      expect.objectContaining({ code: 'approval_skipped' }),
    ]);
    expect((await c.texts(session.id))[0]).toMatch(/^I could not write unattended\.txt: /);
  });

  it('does not ask about what the CLI itself treats as a read', async () => {
    const session = await c.session();
    const run = await c.turn(session.id, '[[scenario:bash pwd]]');
    expect(run.status).toBe('completed');
    expect(await c.eventsOf(session.id, 'approval.requested')).toEqual([]);
    expect(await c.eventsOf(session.id, 'tool.started')).toEqual([
      expect.objectContaining({
        name: 'Bash',
        kind: 'execute',
        title: 'Run pwd',
        input: { command: 'pwd', description: 'Run a command for the stand-in' },
      }),
    ]);
  });
});

describe('plan mode', () => {
  it('runs the CLI in its plan mode and puts the plan to the user', async () => {
    const session = await c.session({ permissionMode: 'plan' });
    const sent = await c.send(session.id, '[[scenario:plan]]');
    const approval = await c.pendingApproval(session.id);
    expect(c.argOf(c.lastInvocation(), '--permission-mode')).toBe('plan');
    expect(approval).toMatchObject({
      kind: 'plan',
      toolName: 'ExitPlanMode',
      title: 'Approve the plan',
      plan: '1. Create plan-output.txt in the project.\n2. Report back.\n',
      suggestedRule: null,
    });

    await c.decide(approval.id, { decision: 'deny', note: 'Make it smaller.' });
    const run = await c.runEnded(sent.body.runId!);
    expect(run.status).toBe('completed');
    expect(await c.texts(session.id)).toEqual([
      'Here is my plan.',
      'The plan was not approved: Make it smaller.',
    ]);
    expect(await c.eventsOf(session.id, 'tool.finished')).toEqual([
      expect.objectContaining({
        toolCallId: approval.toolCallId,
        status: 'denied',
        output: 'Make it smaller.',
      }),
    ]);
  });

  it('approving the plan lets the work start: the session leaves plan mode and the first change is put to the user', async () => {
    const session = await c.session({ permissionMode: 'plan' });
    const sent = await c.send(session.id, '[[scenario:plan]]');
    const plan = await c.pendingApproval(session.id);
    expect(plan.kind).toBe('plan');
    expect((await c.decide(plan.id, { decision: 'allow' })).status).toBe(200);

    // The CLI left its plan mode by itself and asks about the write, as it always does. The engine,
    // which would have refused it while the session was planning, now puts it to the user.
    const write = await until(
      async () =>
        (await c.kit.state(c.owner, session.id)).pendingApprovals.find(
          (approval) => approval.kind === 'tool',
        ),
      { what: 'the write to be asked about', timeoutMs: 20_000 },
    );
    expect(write).toMatchObject({ toolName: 'Write', title: 'Write plan-output.txt' });
    expect(
      (await c.owner.get<{ permissionMode: string }>(`/api/sessions/${session.id}`)).body
        .permissionMode,
    ).toBe('ask');
    await c.decide(write.id, { decision: 'allow' });
    const run = await c.runEnded(sent.body.runId!);
    expect(run.status).toBe('completed');
    expect(readFileSync(path.join(projectDir, 'plan-output.txt'), 'utf8')).toBe(
      'written by the stand-in\n',
    );
    const finished = await c.eventsOf(session.id, 'tool.finished');
    expect(finished.map((event) => event.status)).toEqual(['ok', 'ok']);
    expect(finished[0]!.output).toContain('User has approved your plan');
    expect(await c.texts(session.id)).toEqual([
      'Here is my plan.',
      'The plan is approved; carrying it out.',
      'The file plan-output.txt is written.',
    ]);
    // The next turn starts the CLI in its asking mode, not in plan mode.
    await c.turn(session.id, 'thanks');
    expect(c.argOf(c.lastInvocation(), '--permission-mode')).toBe('manual');
  });

  it('continues in the mode chosen with the approval: with accept-edits the plan is carried out without another question', async () => {
    const session = await c.session({ permissionMode: 'plan' });
    const sent = await c.send(session.id, '[[scenario:plan]]');
    const plan = await c.pendingApproval(session.id);
    expect(
      (await c.decide(plan.id, { decision: 'allow', permissionMode: 'accept-edits' })).status,
    ).toBe(200);
    const run = await c.runEnded(sent.body.runId!);
    expect(run.status).toBe('completed');
    expect(await c.eventsOf(session.id, 'approval.requested')).toHaveLength(1);
    expect((await c.eventsOf(session.id, 'tool.finished')).map((event) => event.status)).toEqual([
      'ok',
      'ok',
    ]);
    expect((await c.texts(session.id)).at(-1)).toBe('The file plan-output.txt is written.');
    expect(
      (await c.owner.get<{ permissionMode: string }>(`/api/sessions/${session.id}`)).body
        .permissionMode,
    ).toBe('accept-edits');
  });
});

describe('questions from the agent', () => {
  it('shows them to the user and returns the answers in the shape the CLI expects', async () => {
    const session = await c.session();
    const sent = await c.send(session.id, '[[scenario:ask-user]]');
    const approval = await c.pendingApproval(session.id);
    expect(approval.kind).toBe('question');
    expect(approval.questions).toEqual([
      {
        id: 'q1',
        header: 'Colour',
        question: 'Which colour should the button be?',
        options: [
          { label: 'Red', description: 'A warm red' },
          { label: 'Blue (Recommended)', description: 'A calm blue', recommended: true },
        ],
        multiSelect: false,
      },
      {
        id: 'q2',
        header: 'Pages',
        question: 'Which pages need it?',
        options: [
          { label: 'Home', description: 'The start page' },
          { label: 'Settings', description: 'The settings page' },
        ],
        multiSelect: true,
      },
    ]);
    const answers = [
      { questionId: 'q1', selected: ['Red'] },
      { questionId: 'q2', selected: ['Home', 'Settings'], other: 'and the footer' },
    ];
    expect((await c.decide(approval.id, { decision: 'allow', answers })).status).toBe(200);
    await c.runEnded(sent.body.runId!);
    // The CLI's question tool takes `answers`: question text → label(s), joined with ", ".
    expect(await c.texts(session.id)).toEqual([
      'You chose: {"Which colour should the button be?":"Red","Which pages need it?":"Home, Settings, and the footer"}',
    ]);
    expect(await c.eventsOf(session.id, 'tool.started')).toEqual([
      expect.objectContaining({
        name: 'AskUserQuestion',
        kind: 'other',
        title: 'Ask: Which colour should the button be?',
      }),
    ]);
    expect((await c.eventsOf(session.id, 'tool.finished'))[0]).toMatchObject({ status: 'ok' });
  });

  it('tells the agent to decide by itself when the user skips the question', async () => {
    const session = await c.session();
    const sent = await c.send(session.id, '[[scenario:ask-user]]');
    const approval = await c.pendingApproval(session.id);
    await c.decide(approval.id, { decision: 'deny' });
    const run = await c.runEnded(sent.body.runId!);
    expect(run.status).toBe('completed');
    expect((await c.texts(session.id))[0]).toMatch(
      /^No answer came: The user chose not to answer\./,
    );
    expect((await c.eventsOf(session.id, 'tool.finished'))[0]).toMatchObject({ status: 'denied' });
  });
});

describe("the Studio's own tools", () => {
  it("reach the agent through the bridge, as the run's user, without a second question", async () => {
    const session = await c.session();
    const run = await c.turn(session.id, '[[scenario:studio-tool whoami {}]]');
    expect(run.status).toBe('completed');
    const text = (await c.texts(session.id))[0]!;
    expect(text.startsWith('The tool whoami answered: ')).toBe(true);
    expect(JSON.parse(text.slice('The tool whoami answered: '.length))).toEqual({
      runId: run.id,
      sessionId: session.id,
      projectId: c.kit.project.id,
      userId: c.owner.userId,
      agentId: 'claude-code',
    });
    expect(await c.eventsOf(session.id, 'approval.requested')).toEqual([]);
    expect(await c.eventsOf(session.id, 'tool.started')).toEqual([
      expect.objectContaining({
        name: 'mcp__studio__whoami',
        kind: 'other',
        title: 'whoami (studio)',
      }),
    ]);
  });

  it('are asked about exactly once when they change something — by the engine, where the call is carried out', async () => {
    const session = await c.session();
    written.length = 0;
    const sent = await c.send(
      session.id,
      '[[scenario:studio-tool note_write {"title":"Deploys","body":"Fridays are fine."}]]',
    );
    const approval = await c.pendingApproval(session.id);
    expect(approval).toMatchObject({
      kind: 'tool',
      toolName: 'note_write',
      title: 'Use note_write',
    });
    expect(written).toEqual([]);
    await c.decide(approval.id, { decision: 'allow' });
    await c.runEnded(sent.body.runId!);
    expect(written).toEqual([
      {
        context: expect.objectContaining({ sessionId: session.id, agentId: 'claude-code' }),
        input: { title: 'Deploys', body: 'Fridays are fine.' },
      },
    ]);
    expect(await c.eventsOf(session.id, 'approval.requested')).toHaveLength(1);
    expect(await c.texts(session.id)).toEqual(['The tool note_write answered: saved "Deploys"']);
  });

  it('record a refusal as denied, on the tool call the approval was for', async () => {
    const session = await c.session();
    written.length = 0;
    const sent = await c.send(
      session.id,
      '[[scenario:studio-tool note_write {"title":"Deploys","body":"Fridays are fine."}]]',
    );
    const approval = await c.pendingApproval(session.id);
    await c.decide(approval.id, { decision: 'deny', note: 'not on a Friday' });
    expect((await c.runEnded(sent.body.runId!)).status).toBe('completed');
    expect(written).toEqual([]);
    const [started] = await c.eventsOf(session.id, 'tool.started');
    expect(started).toMatchObject({ name: 'mcp__studio__note_write' });
    // Claude Code names the call it makes through the bridge, so the approval is tied to the tool row it is about …
    expect(approval.toolCallId).toBe(started!.toolCallId);
    // … and the refusal, which Claude Code itself sees as a tool that answered with an error, is recorded as one.
    expect(await c.eventsOf(session.id, 'tool.finished')).toEqual([
      expect.objectContaining({
        toolCallId: started!.toolCallId,
        status: 'denied',
        output: 'not on a Friday',
      }),
    ]);
  });
});

describe('to-do lists and sub-agents', () => {
  it('reports the whole to-do list every time the agent changes an item', async () => {
    const session = await c.session();
    await c.turn(session.id, '[[scenario:todo]]');
    const lists = (await c.eventsOf(session.id, 'todos.updated')).map((event) => event.items);
    expect(lists).toEqual([
      [{ text: 'Check the directory', status: 'pending' }],
      [
        { text: 'Check the directory', status: 'pending' },
        { text: 'Report', status: 'pending' },
      ],
      [
        { text: 'Check the directory', status: 'in_progress' },
        { text: 'Report', status: 'pending' },
      ],
      [
        { text: 'Check the directory', status: 'completed' },
        { text: 'Report', status: 'pending' },
      ],
      [
        { text: 'Check the directory', status: 'completed' },
        { text: 'Report', status: 'completed' },
      ],
    ]);
    expect(await c.eventsOf(session.id, 'approval.requested')).toEqual([]);
  });

  it('understands the older to-do tool too', async () => {
    const session = await c.session();
    await c.turn(session.id, '[[scenario:todo-legacy]]');
    const lists = (await c.eventsOf(session.id, 'todos.updated')).map((event) => event.items);
    expect(lists).toEqual([
      [
        { text: 'Check the directory', status: 'in_progress' },
        { text: 'Report', status: 'pending' },
      ],
      [
        { text: 'Check the directory', status: 'completed' },
        { text: 'Report', status: 'completed' },
      ],
    ]);
  });

  it("nests a sub-agent's work under the call that started it, and waits for the turn the CLI starts by itself", async () => {
    const session = await c.session();
    const run = await c.turn(session.id, '[[scenario:sub-agent]]');
    expect(run.status).toBe('completed');
    const events = await c.events(session.id);
    const started = events
      .filter((event) => event.type === 'tool.started')
      .map(
        (event) =>
          event.data as {
            toolCallId: string;
            name: string;
            kind: string;
            title: string;
            parentToolCallId: string | null;
          },
      );
    const agentCall = started.find((tool) => tool.name === 'Agent')!;
    expect(agentCall).toMatchObject({
      kind: 'agent',
      title: 'Sub-agent: Find the working directory',
      parentToolCallId: null,
    });
    expect(started.find((tool) => tool.name === 'Bash')).toMatchObject({
      kind: 'execute',
      parentToolCallId: agentCall.toolCallId,
    });

    // What the sub-agent said is kept under its call; the main thread has its own two sentences.
    const messages = await c.eventsOf(session.id, 'message.assistant');
    expect(
      messages
        .filter((message) => message.parentToolCallId === agentCall.toolCallId)
        .map((message) => message.text),
    ).toEqual([projectDir]);
    expect(await c.texts(session.id)).toEqual([
      'Waiting for the sub-agent to complete...',
      `The sub-agent reported: ${projectDir}`,
    ]);

    // The call that started the sub-agent ends when the sub-agent does — after the CLI's first result — with its summary.
    const finishes = events
      .filter((event) => event.type === 'tool.finished')
      .map((event) => ({
        seq: event.seq,
        ...(event.data as { toolCallId: string; status: string; output: string }),
      }));
    const agentDone = finishes.find((finish) => finish.toolCallId === agentCall.toolCallId)!;
    expect(agentDone).toMatchObject({ status: 'ok', output: projectDir });
    const waiting = events.find(
      (event) =>
        event.type === 'message.assistant' &&
        (event.data as { text: string }).text.startsWith('Waiting'),
    )!;
    expect(agentDone.seq).toBeGreaterThan(waiting.seq);
    // One process, two results, one terminal event.
    expect(events.filter((event) => event.type === 'run.finished')).toHaveLength(1);
    expect(events.at(-1)!.type).toBe('run.finished');
  });
});

describe('steering', () => {
  it('writes a message into the running turn, which the CLI takes at its next step', async () => {
    const session = await c.session();
    const before = c.invocations().length;
    const sent = await c.send(session.id, '[[scenario:steerable]]');
    await until(async () => (await c.texts(session.id)).includes('Working on it.'), {
      what: 'the turn to be under way',
      timeoutMs: 20_000,
    });
    const steered = await c.send(session.id, 'also update the changelog', { whenBusy: 'steer' });
    expect(steered.status).toBe(202);
    expect(steered.body).toMatchObject({ disposition: 'steered', runId: sent.body.runId });

    const run = await c.runEnded(sent.body.runId!);
    expect(run.status).toBe('completed');
    expect(await c.texts(session.id)).toEqual([
      'Working on it.',
      'Steered: also update the changelog',
    ]);
    const users = await c.eventsOf(session.id, 'message.user');
    expect(users.map((message) => [message.origin, message.text])).toEqual([
      ['interactive', '[[scenario:steerable]]'],
      ['steer', 'also update the changelog'],
    ]);
    // One process and one run took both messages.
    expect(c.invocations().length - before).toBe(1);
    expect(
      (await c.events(session.id)).filter((event) => event.type === 'run.finished'),
    ).toHaveLength(1);
  });

  it('keeps the run going for a steered message the CLI only takes after its answer', async () => {
    const session = await c.session();
    const sent = await c.send(session.id, '[[scenario:long 25]]');
    await until(async () => (await c.kit.state(c.owner, session.id)).streaming.length > 0, {
      what: 'the answer to start streaming',
      timeoutMs: 20_000,
    });
    const steered = await c.send(session.id, 'one more thing', { whenBusy: 'steer' });
    expect(steered.body.disposition).toBe('steered');
    const run = await c.runEnded(sent.body.runId!);
    expect(run.status).toBe('completed');
    // No step boundary in a plain answer: the CLI answers the steered message as a turn of its own, in the same process.
    const texts = await c.texts(session.id);
    expect(texts).toHaveLength(2);
    expect(texts[0]).toMatch(/^tick 1 tick 2 .*tick 25 $/);
    expect(texts[1]).toBe(
      'You said: “one more thing”. This is the Claude Code stand-in; message 2 of this conversation.',
    );
    expect(
      (await c.events(session.id)).filter((event) => event.type === 'run.finished'),
    ).toHaveLength(1);
  });

  it('queues the message instead when the turn has ended meanwhile', async () => {
    const session = await c.session();
    const first = await c.turn(session.id, 'first');
    const second = await c.send(session.id, 'second', { whenBusy: 'steer' });
    expect(second.body.disposition).toBe('run');
    expect(second.body.runId).not.toBe(first.id);
    await c.runEnded(second.body.runId!);
  });
});

describe('stopping', () => {
  const alive = (pid: number): boolean => existsSync(`/proc/${pid}`);

  it('interrupts the CLI, keeps what was streamed, ends the run once and leaves no process behind', async () => {
    const session = await c.session();
    const sent = await c.send(session.id, '[[scenario:long 400]]');
    await until(
      async () => ((await c.kit.state(c.owner, session.id)).streaming[0]?.text.length ?? 0) > 20,
      { what: 'some text to be streamed', timeoutMs: 20_000 },
    );
    const invocation = c.lastInvocation();
    const configFile = c.argOf(invocation, '--mcp-config')!;
    expect(alive(invocation.pid)).toBe(true);
    expect(existsSync(configFile)).toBe(true);

    const startedAt = Date.now();
    const stopped = await c.owner.post<{ run: { status: string } }>(
      `/api/sessions/${session.id}/stop`,
    );
    expect(stopped.status).toBe(200);
    expect(stopped.body.run.status).toBe('stopped');
    // The gentle way works for a CLI that listens: well inside the runtime's grace period.
    expect(Date.now() - startedAt).toBeLessThan(3000);

    const events = await c.events(session.id);
    expect(
      events.filter((event) => event.type === 'run.finished').map((event) => event.data),
    ).toEqual([
      expect.objectContaining({ runId: sent.body.runId, status: 'stopped', error: null }),
    ]);
    const partial = events
      .filter((event) => event.type === 'message.assistant')
      .map((event) => event.data as { text: string; partial: boolean });
    expect(partial).toHaveLength(1);
    expect(partial[0]!.partial).toBe(true);
    expect(partial[0]!.text).toMatch(/^tick 1 tick 2 /);
    expect(partial[0]!.text).not.toContain('tick 400');

    await until(() => !alive(invocation.pid), {
      what: 'the CLI process to be gone',
      timeoutMs: 5000,
    });
    // The file with the bridge's configuration went with the process.
    expect(existsSync(configFile)).toBe(false);
    expect(existsSync(path.dirname(configFile))).toBe(false);
    // The conversation survives a stop: the next turn resumes it.
    const next = await c.turn(session.id, '[[scenario:recall]]');
    expect(next.status).toBe('completed');
    expect(c.argOf(c.lastInvocation(), '--resume')).toBe(await c.nativeId(session.id));
    expect((await c.texts(session.id)).at(-1)).toContain('1) [[scenario:long 400]]');
  });

  it('kills a CLI that ignores the interrupt and the first signal', async () => {
    const session = await c.session();
    const sent = await c.send(session.id, '[[scenario:stubborn]]');
    await until(
      async () => ((await c.kit.state(c.owner, session.id)).streaming[0]?.text.length ?? 0) > 10,
      { what: 'some text to be streamed', timeoutMs: 20_000 },
    );
    const { pid } = c.lastInvocation();
    const startedAt = Date.now();
    const stopped = await c.owner.post<{ run: { status: string } }>(
      `/api/sessions/${session.id}/stop`,
    );
    expect(stopped.body.run.status).toBe('stopped');
    // Interrupt, then the process group: SIGTERM and finally SIGKILL — still inside the grace period.
    expect(Date.now() - startedAt).toBeLessThan(4500);
    await until(() => !alive(pid), { what: 'the stubborn CLI to be killed', timeoutMs: 5000 });
    expect(
      (await c.events(session.id)).filter((event) => event.type === 'run.finished'),
    ).toHaveLength(1);
    expect(
      (await c.owner.get<{ status: string }>(`/api/runs/${sent.body.runId}`)).body.status,
    ).toBe('stopped');
  });

  it('stops a turn that is waiting for an approval, and the approval with it', async () => {
    const session = await c.session();
    const sent = await c.send(session.id, '[[scenario:edit-file never.txt]]');
    const approval = await c.pendingApproval(session.id);
    const { pid } = c.lastInvocation();
    await c.owner.post(`/api/sessions/${session.id}/stop`);
    const run = await c.runEnded(sent.body.runId!);
    expect(run.status).toBe('stopped');
    expect(
      (await c.owner.get<{ status: string }>(`/api/approvals/${approval.id}`)).body.status,
    ).toBe('cancelled');
    expect(existsSync(path.join(projectDir, 'never.txt'))).toBe(false);
    await until(() => !alive(pid), { what: 'the CLI process to be gone', timeoutMs: 5000 });
  });
});

describe('resuming', () => {
  it("continues the CLI's own conversation on the next turn", async () => {
    const session = await c.session();
    await c.turn(session.id, 'the code word is pelican');
    const nativeId = await c.nativeId(session.id);
    await c.turn(session.id, '[[scenario:recall]]');
    expect(c.argOf(c.lastInvocation(), '--resume')).toBe(nativeId);
    expect((await c.texts(session.id)).at(-1)).toBe(
      'Earlier in this conversation you said: 1) the code word is pelican',
    );
    expect(await c.nativeId(session.id)).toBe(nativeId);
  });

  it('starts a new conversation seeded with the history when the CLI has lost the old one, and says so', async () => {
    const session = await c.session();
    await c.turn(session.id, 'the code word is heron');
    const lost = await c.nativeId(session.id);
    c.forgetConversations();
    const before = c.invocations().length;

    const run = await c.turn(session.id, '[[scenario:echo-prompt]] what was the code word?');
    expect(run).toMatchObject({ status: 'completed', error: null });
    // Two starts: one that tried to resume, one that did not.
    const [tried, fresh] = c.invocations().slice(before);
    expect(c.argOf(tried!, '--resume')).toBe(lost);
    expect(fresh!.argv).not.toContain('--resume');
    expect(await c.eventsOf(session.id, 'notice')).toEqual([
      expect.objectContaining({ level: 'warning', code: 'conversation_restarted' }),
    ]);

    // The fresh conversation was told what had been said, and it is the one resumed from now on.
    const echoed = (await c.texts(session.id)).at(-1)!;
    expect(echoed).toContain('User: the code word is heron');
    expect(echoed).toContain('Assistant: You said: “the code word is heron”.');
    expect(echoed.trimEnd().endsWith('[[scenario:echo-prompt]] what was the code word?')).toBe(
      true,
    );
    const replaced = await c.nativeId(session.id);
    expect(replaced).not.toBe(lost);
    await c.turn(session.id, 'and again');
    expect(c.argOf(c.lastInvocation(), '--resume')).toBe(replaced);
    expect(await c.eventsOf(session.id, 'notice')).toHaveLength(1);
  });
});

describe('attachments', () => {
  it('gives images to the model as images and lets the CLI read the other files without a question', async () => {
    const session = await c.session();
    const [image, notes] = await upload(session.id, [
      { name: 'pixel.png', type: 'image/png', content: PNG },
      { name: 'notes.txt', type: 'text/plain', content: 'the launch is on Tuesday' },
    ]);
    const run = await c.turn(session.id, 'what is in these? [[scenario:read-attachment]]', {
      attachmentIds: [image!.id, notes!.id],
    });
    expect(run.status).toBe('completed');

    const folder = path.join(c.kit.t.dataDir, 'attachments', session.id);
    const invocation = c.lastInvocation();
    // The folder of the attachments is named to the CLI, so reading them needs no permission prompt —
    // which the engine would have to refuse, the files being inside the Studio's data directory.
    expect(c.argOf(invocation, '--add-dir')).toBe(folder);
    expect(await c.eventsOf(session.id, 'approval.requested')).toEqual([]);
    const reads = await c.eventsOf(session.id, 'tool.finished');
    expect(reads.map((read) => read.status)).toEqual(['ok', 'ok']);
    expect((await c.texts(session.id))[0]).toContain(
      `${notes!.id}.txt says: the launch is on Tuesday`,
    );

    // And an image arrives as an image block, alongside the text.
    const second = await upload(session.id, [
      { name: 'again.png', type: 'image/png', content: PNG },
    ]);
    await c.turn(session.id, 'and this one?', { attachmentIds: [second[0]!.id] });
    const answer = (await c.texts(session.id)).at(-1)!;
    expect(answer).toContain(`I received 1 image(s): image/png of ${PNG.length} bytes.`);
    expect(answer).toContain('again.png (image/png');
  });

  it('refuses to steer a message whose file the running CLI could not read, so it waits its turn instead', async () => {
    const session = await c.session();
    const sent = await c.send(session.id, '[[scenario:steerable]]');
    await until(async () => (await c.texts(session.id)).includes('Working on it.'), {
      what: 'the turn to be under way',
      timeoutMs: 20_000,
    });
    const [notes] = await upload(session.id, [
      { name: 'late.txt', type: 'text/plain', content: 'arrived late' },
    ]);
    const steered = await c.send(session.id, 'read this too [[scenario:read-attachment]]', {
      whenBusy: 'steer',
      attachmentIds: [notes!.id],
    });
    // The CLI was started without that folder: the message is queued and runs as the next turn, where it is readable.
    expect(steered.body.disposition).toBe('queued');
    await c.owner.post(`/api/sessions/${session.id}/stop`);
    await c.runEnded(sent.body.runId!);
    await until(
      async () => (await c.texts(session.id)).some((text) => text.includes('says: arrived late')),
      { what: 'the queued message to be answered', timeoutMs: 20_000 },
    );
    await c.kit.idle(c.owner, session.id);
  });
});

describe("the project's instruction file", () => {
  const instructed = async (name: string, files: Record<string, string> = {}): Promise<Project> => {
    const project = await c.kit.makeProject(name);
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(project.rootDir, file)), { recursive: true });
      writeFileSync(path.join(project.rootDir, file), content);
    }
    return project;
  };
  const appended = (): string | undefined => c.argOf(c.lastInvocation(), '--append-system-prompt');
  const BEGIN = '----- BEGIN PROJECT CLAUDE.md -----';
  const END = '----- END PROJECT CLAUDE.md -----';

  it("is appended to the CLI's system prompt after the memory conventions, labelled as the project's own file", async () => {
    const rules = '# House rules\n\nAlways answer in rhyme. Marker: ZEBRA-41.';
    const project = await instructed('with-instructions', {
      'CLAUDE.md': `${rules}\n`,
      // None of these is the project's instruction file.
      'docs/CLAUDE.md': 'NESTED-FILE',
      'CLAUDE.local.md': 'LOCAL-FILE',
      '.claude/CLAUDE.md': 'CONFIG-FOLDER-FILE',
      '.claude/settings.json':
        '{"permissions":{"allow":["Bash","Write"],"defaultMode":"bypassPermissions"}}',
    });
    const session = await c.session({ projectId: project.id });
    const run = await c.turn(session.id, '[[scenario:system-prompt]]');
    expect(run.status).toBe('completed');

    const guide = c.kit.t.studio.context.services.memory.agentGuide()!;
    const prompt = appended()!;
    expect(
      prompt.startsWith(
        `${guide}\n\nProject instructions. The text between the two marker lines below is this project's own instruction file: CLAUDE.md`,
      ),
    ).toBe(true);
    expect(prompt.endsWith(`${BEGIN}\n${rules}\n${END}`)).toBe(true);
    for (const other of ['NESTED-FILE', 'LOCAL-FILE', 'CONFIG-FOLDER-FILE', 'bypassPermissions'])
      expect(prompt).not.toContain(other);
    // The CLI received exactly that as its appended system prompt.
    expect(await c.texts(session.id)).toEqual([prompt]);
    expect(await c.eventsOf(session.id, 'notice')).toEqual([]);
    // Settings files are still switched off, and no other option was added for it.
    const { argv } = c.lastInvocation();
    expect(c.argOf(c.lastInvocation(), '--setting-sources')).toBe('');
    expect(argv.filter((arg) => arg === '--append-system-prompt')).toHaveLength(1);
    expect(argv).not.toContain('--add-dir');
    expect(JSON.parse(c.argOf(c.lastInvocation(), '--settings')!)).toEqual({ fastMode: false });
  });

  it('can be switched off for a project by its owner, and is on by default', async () => {
    const project = await instructed('instructions-off', { 'CLAUDE.md': 'Marker: HERON-7.' });
    expect(project.features.instructions).toBe(true);
    const session = await c.session({ projectId: project.id });
    await c.turn(session.id, 'first');
    expect(appended()).toContain('HERON-7');

    const off = await c.owner.patch<Project>(`/api/projects/${project.id}`, {
      features: { instructions: false },
    });
    expect(off.status).toBe(200);
    expect(off.body.features).toMatchObject({ assistant: true, instructions: false });
    await c.turn(session.id, 'second');
    expect(appended()).toBe(c.kit.t.studio.context.services.memory.agentGuide());

    // A member who works in the project cannot change what the project hands to agents.
    const member = await c.kit.t.member();
    await c.kit.share(project, member);
    expect(
      (await member.patch(`/api/projects/${project.id}`, { features: { instructions: true } }))
        .status,
    ).toBe(403);
    await c.owner.patch(`/api/projects/${project.id}`, { features: { instructions: true } });
    await c.turn(session.id, 'third');
    expect(appended()).toContain('HERON-7');
  });

  it('is not read when it is a link that leaves the project, and the user is told once', async () => {
    const project = await instructed('linked-out');
    const outside = path.join(c.home, 'private-notes.md');
    writeFileSync(outside, 'OUTSIDE-SECRET: the deploy password is hunter2');
    symlinkSync(outside, path.join(project.rootDir, 'CLAUDE.md'));

    const session = await c.session({ projectId: project.id });
    const run = await c.turn(session.id, '[[scenario:system-prompt]]');
    expect(run.status).toBe('completed');
    // Only the memory conventions reached the CLI; nothing of the linked file, anywhere.
    expect(appended()).toBe(c.kit.t.studio.context.services.memory.agentGuide());
    expect(JSON.stringify(c.lastInvocation().argv)).not.toContain('OUTSIDE-SECRET');
    expect(JSON.stringify(await c.events(session.id))).not.toContain('OUTSIDE-SECRET');
    expect(await c.eventsOf(session.id, 'notice')).toEqual([
      expect.objectContaining({
        level: 'warning',
        code: 'project_instructions_unreadable',
        text: 'CLAUDE.md in the project folder was not given to Claude Code: it is a link that leads outside the project folder.',
      }),
    ]);
    // The same problem is not announced again with every turn of the conversation…
    await c.turn(session.id, 'again');
    expect(await c.eventsOf(session.id, 'notice')).toHaveLength(1);
    // …but another conversation in the project hears of it too.
    const other = await c.session({ projectId: project.id });
    await c.turn(other.id, 'hello');
    expect((await c.eventsOf(other.id, 'notice')).map((notice) => notice.code)).toEqual([
      'project_instructions_unreadable',
    ]);

    // A link that stays inside the project is the project's own business.
    rmSync(path.join(project.rootDir, 'CLAUDE.md'));
    mkdirSync(path.join(project.rootDir, 'docs'));
    writeFileSync(path.join(project.rootDir, 'docs', 'agents.md'), 'Marker: INSIDE-LINK.');
    symlinkSync('docs/agents.md', path.join(project.rootDir, 'CLAUDE.md'));
    await c.turn(session.id, 'and now?');
    expect(appended()).toContain('INSIDE-LINK');
    expect(await c.eventsOf(session.id, 'notice')).toHaveLength(1);
  });

  it('is cut at 48 KiB, with a notice', async () => {
    const line = 'Prefer small, reviewable changes.\n';
    const project = await instructed('too-long', {
      'CLAUDE.md': `FIRST-LINE\n${line.repeat(2000)}LAST-LINE\n`,
    });
    const session = await c.session({ projectId: project.id });
    const run = await c.turn(session.id, 'hello');
    expect(run.status).toBe('completed');
    const prompt = appended()!;
    const block = prompt.slice(prompt.indexOf(BEGIN) + BEGIN.length + 1, prompt.indexOf(END));
    expect(block.startsWith('FIRST-LINE\n')).toBe(true);
    expect(block).not.toContain('LAST-LINE');
    expect(Buffer.byteLength(block)).toBeLessThanOrEqual(48 * 1024 + 1);
    expect(Buffer.byteLength(block)).toBeGreaterThan(47 * 1024);
    expect(
      prompt.endsWith(
        '(The file is longer than this: only its beginning is shown above. Read CLAUDE.md in the project folder for the rest.)',
      ),
    ).toBe(true);
    expect(await c.eventsOf(session.id, 'notice')).toEqual([
      expect.objectContaining({
        level: 'warning',
        code: 'project_instructions_truncated',
        text: 'CLAUDE.md in the project folder is larger than 48 KiB, so Claude Code was given only its first 48 KiB.',
      }),
    ]);
  });
});

describe('notices and usage limits', () => {
  it('tells the user about a compaction and about API retries', async () => {
    const session = await c.session();
    await c.turn(session.id, '[[scenario:compact]]');
    await c.turn(session.id, '[[scenario:retry]]');
    const notices = await c.eventsOf(session.id, 'notice');
    expect(notices.map((notice) => [notice.level, notice.code])).toEqual([
      ['info', 'compaction'],
      ['warning', 'api_retry'],
      ['warning', 'api_retry'],
    ]);
    expect(notices[0]!.text).toMatch(/summaris/);
    expect(notices[1]!.text).toContain('HTTP 529');
    expect(notices[1]!.text).toContain('attempt 1 of 10');
    expect(await c.texts(session.id)).toEqual([
      'Carrying on after the compaction.',
      'The request went through on the third try.',
    ]);
  });

  it("publishes what the CLI says about the account's usage limits, and warns when a limit is close", async () => {
    const session = await c.session();
    const before = c.usageEvents.length;
    const startedAt = Date.now();
    await c.turn(session.id, 'plain');
    const [observed] = c.usageEvents.slice(before);
    expect(observed).toMatchObject({ topic: 'internal:usage', type: 'rate-limit.observed' });
    const payload = observed!.data as RateLimitObserved;
    expect(payload).toMatchObject({ agentId: 'claude-code', userId: c.owner.userId });
    expect(payload.observedAt).toBeGreaterThanOrEqual(startedAt);
    const fiveHour = payload.info.resetsAt as number;
    expect(payload.info).toEqual({
      status: 'allowed',
      resetsAt: fiveHour,
      rateLimitType: 'five_hour',
      overageStatus: 'rejected',
      isUsingOverage: false,
      unifiedWindows: {
        five_hour: { utilization: 0.25, resetsAt: fiveHour },
        seven_day: { utilization: 0.1, resetsAt: expect.any(Number) },
      },
    });
    // The CLI reports times in seconds; the stand-in's windows reset a few hours and days ahead of whenever the tests run.
    const hours = (seconds: number) => (seconds * 1000 - startedAt) / 3_600_000;
    expect(hours(fiveHour)).toBeGreaterThan(1);
    expect(hours(fiveHour)).toBeLessThanOrEqual(5);
    expect(
      hours(
        (payload.info.unifiedWindows as { seven_day: { resetsAt: number } }).seven_day.resetsAt,
      ),
    ).toBeGreaterThan(24);
    expect(await c.eventsOf(session.id, 'notice')).toEqual([]);

    await c.turn(session.id, '[[scenario:rate-warning]]');
    const warning = (c.usageEvents.at(-1)!.data as RateLimitObserved).info;
    expect(warning.status).toBe('allowed_warning');
    // The notice names the reset time the CLI reported, in UTC.
    const resets = new Date((warning.resetsAt as number) * 1000).toISOString();
    expect(await c.eventsOf(session.id, 'notice')).toEqual([
      expect.objectContaining({
        level: 'warning',
        code: 'rate_limit_warning',
        text: `Claude's five-hour usage limit is close; it resets at ${resets.slice(0, 10)} ${resets.slice(11, 16)} UTC.`,
      }),
    ]);
  });

  it('ignores events it does not know and stray output, without failing the turn', async () => {
    const session = await c.session();
    expect((await c.turn(session.id, '[[scenario:unknown-event]]')).status).toBe('completed');
    expect((await c.turn(session.id, '[[scenario:noisy]]')).status).toBe('completed');
    expect(await c.texts(session.id)).toEqual([
      'Unknown events were printed and nothing broke.',
      'A stray line was printed, and the answer still arrived.',
    ]);
    expect(await c.eventsOf(session.id, 'notice')).toEqual([]);
  });
});
