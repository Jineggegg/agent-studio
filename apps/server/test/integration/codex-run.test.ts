import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  type Agent,
  type MessageReceipt,
  type Run,
  type ServerFrame,
  type Session,
  sessionTopic,
} from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StudioEvent } from '../../src/kernel/events.js';
import { PERMISSIONS_GUIDE } from '../../src/modules/codex/adapter.js';
import {
  type CodexKit,
  assistantTexts,
  createCodexKit,
  eventsOf,
  inspection,
  processExists,
} from '../../src/modules/codex/testing/kit.js';
import { nextRequestId, until } from '../../src/testing/agents-kit.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('the Codex adapter, driving the stand-in CLI', () => {
  let kit: CodexKit;
  const usage: StudioEvent[] = [];
  beforeAll(async () => {
    kit = await createCodexKit();
    kit.t.studio.context.bus.onTopic('internal:usage', (event) => usage.push(event));
  });
  afterAll(async () => {
    await kit.close();
  });

  it('reports what the CLI says about itself: version, sign-in, account and models', async () => {
    const agent = (await kit.owner.get<Agent>('/api/agents/codex')).body;
    expect(agent).toMatchObject({
      id: 'codex',
      displayName: 'Codex',
      kind: 'cli',
      status: {
        installed: true,
        version: '0.160.0-standin',
        signedIn: true,
        account: 'codex-standin@example.test',
        problem: null,
      },
      capabilities: {
        defaultModel: 'standin-large',
        permissionModes: ['plan', 'ask', 'accept-edits', 'auto'],
        images: true,
        steering: true,
        resume: true,
        planMode: true,
        usage: true,
      },
    });
    expect(agent.capabilities.models).toEqual([
      {
        id: 'standin-large',
        fastMode: false,
        label: 'Stand-in Large',
        description: 'Answers from a script. For tests.',
        recommended: true,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      },
      {
        id: 'standin-small',
        fastMode: false,
        label: 'Stand-in Small',
        description: 'The same script, labelled smaller.',
        efforts: ['low'],
        defaultEffort: 'low',
      },
    ]);
  });

  it('streams an answer and records it in order, with usage and the rate limits it saw', async () => {
    const { owner } = kit;
    const session = await kit.codexSession();
    const live = await kit.connect(owner);
    await live.subscribe(sessionTopic(session.id));
    usage.length = 0;

    const run = await kit.turn(owner, session.id, 'What is in this folder?');
    expect(run).toMatchObject({ status: 'completed', error: null, agentId: 'codex' });

    const events = await kit.events(owner, session.id);
    expect(events.map((event) => event.type)).toEqual([
      'message.user',
      'run.started',
      'message.assistant',
      'usage.reported',
      'run.finished',
    ]);
    expect(eventsOf(events, 'message.assistant')[0]!.data).toMatchObject({
      text: 'Hello from the Codex stand-in. You said: What is in this folder?',
      model: 'standin-large',
      partial: false,
      parentToolCallId: null,
    });
    // Codex counts cached tokens inside the input; the Studio keeps them apart.
    expect(eventsOf(events, 'usage.reported')[0]!.data).toMatchObject({
      model: 'standin-large',
      inputTokens: 200,
      cacheReadTokens: 1000,
      cacheWriteTokens: 0,
      outputTokens: 40,
      contextTokens: 1240,
      contextWindow: 258400,
    });

    // The text arrived in pieces before it arrived whole.
    await live.next((frame) => frame.op === 'event' && frame.type === 'run.finished');
    const frames = live.events(sessionTopic(session.id));
    const deltas = frames.filter((frame) => frame.type === 'message.delta');
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.map((frame) => (frame.data as { text: string }).text).join('')).toBe(
      'Hello from the Codex stand-in. You said: What is in this folder?',
    );
    expect(frames.findIndex((frame) => frame.type === 'message.delta')).toBeLessThan(
      frames.findIndex((frame) => frame.type === 'message.assistant'),
    );
    live.close();

    // The agent's own conversation id is kept on the server and never shown in an event.
    const native = (
      await owner.get<{ nativeSessionId: string }>(`/api/sessions/${session.id}/native-id`)
    ).body.nativeSessionId;
    expect(native).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(events)).not.toContain(native);

    expect(usage.map((event) => event.type)).toContain('rate-limit.observed');
    const observed = usage.find((event) => event.type === 'rate-limit.observed')!.data as {
      info: { primary: { resetsAt: number } };
    };
    expect(observed).toMatchObject({
      agentId: 'codex',
      userId: owner.userId,
      info: {
        limitId: 'codex',
        planType: 'plus',
        primary: { usedPercent: 17, windowMinutes: 10080, resetsAt: expect.any(Number) },
        secondary: null,
        credits: null,
        reached: null,
      },
    });
    // Codex reports the reset in seconds; the Studio keeps milliseconds. The stand-in's weekly window resets three days ahead, on the hour.
    const resetsAt = observed.info.primary.resetsAt;
    expect(resetsAt % 3_600_000).toBe(0);
    expect(resetsAt - Date.now()).toBeGreaterThan(2 * 24 * 3_600_000);
    expect(resetsAt - Date.now()).toBeLessThanOrEqual(3 * 24 * 3_600_000 + 3_600_000);
  });

  it('starts the CLI in the project, with the settings that make it ask, and nothing of the server in its environment', async () => {
    const { owner, project } = kit;
    process.env.AGENT_STUDIO_TEST_SECRET = 'must-not-leak';
    process.env.OPENAI_API_KEY = 'sk-must-not-be-used-0123456789';
    process.env.CODEX_API_KEY = 'sk-must-not-be-used-either-0123';
    try {
      const session = await kit.codexSession({ model: 'standin-small', effort: 'low' });
      await kit.turn(owner, session.id, '[[scenario:inspect]]');
      const seen = inspection(await kit.events(owner, session.id));

      expect(seen.cwd).toBe(project.rootDir);
      expect(seen).toMatchObject({
        model: 'standin-small',
        effort: 'low',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'read-only',
      });
      expect(seen.features).toMatchObject({ hooks: false, apps: false, plugins: false });

      expect(seen.environment.filter((name) => name.startsWith('AGENT_STUDIO_'))).toEqual([]);
      expect(seen.environment).not.toContain('OPENAI_API_KEY');
      expect(seen.environment).not.toContain('CODEX_API_KEY');
      expect(seen.environment).toEqual(
        expect.arrayContaining(['HOME', 'PATH', 'STUDIO_BRIDGE_TOKEN', 'STUDIO_BRIDGE_URL']),
      );

      // The bridge is registered for this process only, by name, and its token is not on the command line.
      expect(seen.tokenInArguments).toBe(false);
      expect(seen.argv.join('\n')).not.toMatch(/STUDIO_BRIDGE_TOKEN\s*=|must-not/);
      expect(seen.argv).toContain(
        'mcp_servers.studio.env_vars=["STUDIO_BRIDGE_URL", "STUDIO_BRIDGE_TOKEN"]',
      );
      expect(seen.mcpServers.studio).toMatchObject({ command: process.execPath, enabled: true });
      expect(seen.mcpServers.studio!.args!.at(-1)).toMatch(/mcp-bridge\.(ts|js)$/);
    } finally {
      delete process.env.AGENT_STUDIO_TEST_SECRET;
      delete process.env.OPENAI_API_KEY;
      delete process.env.CODEX_API_KEY;
    }
  });

  it('gives Codex its standing instructions — how to ask under the Studio, and the memory conventions — and writes nothing into the project', async () => {
    const { owner, project } = kit;
    const guide = kit.t.studio.context.services.memory.agentGuide();
    expect(guide).toEqual(expect.any(String));
    const session = await kit.codexSession();
    await kit.turn(owner, session.id, '[[scenario:inspect]]');
    const instructions = inspection(await kit.events(owner, session.id)).developerInstructions;
    expect(instructions).toBe(`${PERMISSIONS_GUIDE}\n\n${guide}`);
    expect(instructions).toMatch(/^## Permissions in this session \(Cloud Harness\)\n/);
    expect(instructions).toContain('sandbox_permissions: "require_escalated"');
    const records = await kit.records();
    expect(records.findLast((record) => record.event === 'thread/start')!.params).toMatchObject({
      cwd: project.rootDir,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
      developerInstructions: instructions,
    });
    expect(existsSync(path.join(project.rootDir, 'AGENTS.md'))).toBe(false);
    expect(existsSync(path.join(project.rootDir, '.codex'))).toBe(false);
  });

  it('shows reasoning, a to-do list, a web search and a sub-agent as what they are', async () => {
    const { owner } = kit;
    const session = await kit.codexSession();
    await kit.turn(
      owner,
      session.id,
      '[[scenario:thinking]] [[scenario:plan]] [[scenario:web-search bubblewrap nesting]] [[scenario:sub-agent]]',
    );
    const events = await kit.events(owner, session.id);

    expect(eventsOf(events, 'thinking').map((event) => event.data.text)).toEqual([
      'Reading the request.\n\nChoosing a short answer.',
    ]);
    expect(eventsOf(events, 'todos.updated').map((event) => event.data.items)).toEqual([
      [
        { text: 'Read the code', status: 'in_progress' },
        { text: 'Write the fix', status: 'pending' },
      ],
      [
        { text: 'Read the code', status: 'completed' },
        { text: 'Write the fix', status: 'in_progress' },
      ],
    ]);

    const started = eventsOf(events, 'tool.started').map((event) => event.data);
    const search = started.find((tool) => tool.name === 'web_search')!;
    expect(search).toMatchObject({ kind: 'fetch', title: 'Search the web: bubblewrap nesting' });
    const spawn = started.find((tool) => tool.kind === 'agent')!;
    expect(spawn).toMatchObject({
      name: 'spawnAgent',
      title: 'Start a sub-agent: Look into the tests.',
    });
    for (const tool of [search, spawn]) {
      expect(
        eventsOf(events, 'tool.finished').find(
          (event) => event.data.toolCallId === tool.toolCallId,
        )!.data.status,
      ).toBe('ok');
    }

    // What the sub-agent said hangs under the call that started it; its turn ending did not end the run.
    const texts = eventsOf(events, 'message.assistant').map((event) => event.data);
    expect(texts.find((text) => text.text === 'The tests look fine.')).toMatchObject({
      parentToolCallId: spawn.toolCallId,
    });
    expect(texts.at(-1)).toMatchObject({
      text: 'My sub-agent reports that the tests look fine.',
      parentToolCallId: null,
    });
    expect(eventsOf(events, 'run.finished')).toHaveLength(1);
  });

  it('turns retries, warnings, compaction and a new name into notices and a title, and shrugs off what it does not know', async () => {
    const { owner } = kit;
    const session = await kit.codexSession();
    const run = await kit.turn(
      owner,
      session.id,
      '[[scenario:retry]] [[scenario:warning]] [[scenario:compact]] [[scenario:rename Fix the flaky test]] [[scenario:unknown-event]] [[scenario:noise]]',
    );
    expect(run.status).toBe('completed');
    const events = await kit.events(owner, session.id);
    expect(eventsOf(events, 'notice').map((event) => [event.data.level, event.data.code])).toEqual([
      // Two attempts, one line.
      ['warning', 'codex_retry'],
      ['warning', 'codex_warning'],
      ['info', 'compaction'],
    ]);
    expect(assistantTexts(events)).toEqual([
      'The connection came back and here is the answer.',
      'That was a warning; the answer is unaffected.',
      'I made room and carried on.',
      'I gave this conversation a name.',
      'The client declined a request it did not know, as it should.',
      'I printed some JSON that is not a message.',
    ]);
    expect((await owner.get<Session>(`/api/sessions/${session.id}`)).body.title).toBe(
      'Fix the flaky test',
    );
  });

  it('continues the conversation Codex has, and starts a seeded one when Codex has lost it', async () => {
    const { owner } = kit;
    const session = await kit.codexSession();
    await kit.turn(owner, session.id, 'Remember the word heliotrope.');
    const native = (
      await owner.get<{ nativeSessionId: string }>(`/api/sessions/${session.id}/native-id`)
    ).body.nativeSessionId;

    await kit.turn(owner, session.id, '[[scenario:recall]]');
    let events = await kit.events(owner, session.id);
    expect(assistantTexts(events).at(-1)).toBe(
      'Earlier in this conversation: 1. user: Remember the word heliotrope. | 2. assistant: Hello from the Codex stand-in. You said: Remember the word heliotrope.',
    );
    expect(
      (await kit.records()).findLast((record) => record.event === 'thread/resume')!.params,
    ).toMatchObject({
      threadId: native,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox: 'read-only',
    });
    // A reopened conversation repeats the token figures of its previous turn; they are not counted twice.
    expect(eventsOf(events, 'usage.reported')).toHaveLength(2);
    expect(
      (
        await owner.get<{
          totals: Array<{ inputTokens: number; outputTokens: number; cacheReadTokens: number }>;
        }>(`/api/sessions/${session.id}/usage`)
      ).body.totals,
    ).toEqual([
      expect.objectContaining({ inputTokens: 400, outputTokens: 80, cacheReadTokens: 2000 }),
    ]);

    // Codex forgets (its copy of the conversation is gone).
    await rm(path.join(kit.standinState, 'threads', `${native}.json`));
    await kit.turn(owner, session.id, '[[scenario:recall]] once more');
    events = await kit.events(owner, session.id);
    expect(eventsOf(events, 'notice').map((event) => event.data)).toEqual([
      expect.objectContaining({ level: 'warning', code: 'resume_unavailable' }),
    ]);
    // The new conversation was given what the Studio remembers, as conversation.
    expect(assistantTexts(events).at(-1)).toMatch(
      /^Earlier in this conversation: 1\. user: Remember the word heliotrope\. \| 2\. assistant: Hello from the Codex stand-in\. You said: Remember the word heliotrope\. \| 3\. user: {2}\| 4\. assistant: Earlier in this conversation/,
    );
    const fresh = (
      await owner.get<{ nativeSessionId: string }>(`/api/sessions/${session.id}/native-id`)
    ).body.nativeSessionId;
    expect(fresh).not.toBe(native);
  });

  it('hands over attachments: an image as an image, another file by its path', async () => {
    const { owner } = kit;
    const session = await kit.codexSession();
    const attachmentIds = await kit.upload(session.id, [
      { name: 'screen.png', content: PNG, type: 'image/png' },
      { name: 'notes.txt', content: 'the notes', type: 'text/plain' },
    ]);
    await kit.turn(owner, session.id, '[[scenario:inspect]] [[scenario:echo-prompt]]', {
      attachmentIds,
    });
    const events = await kit.events(owner, session.id);
    const seen = inspection(events);
    expect(seen.images).toHaveLength(1);
    expect(seen.images[0]).toMatchObject({ bytes: PNG.length });
    expect(seen.images[0]!.path.startsWith(kit.t.dataDir)).toBe(true);

    const prompt = assistantTexts(events).at(-1)!;
    const listed = /Attached files \(read them at these paths\):\n- notes\.txt: (\S+)/.exec(prompt);
    expect(listed).not.toBeNull();
    expect(await readFile(listed![1]!, 'utf8')).toBe('the notes');
    expect(prompt).not.toContain('screen.png');
  });

  it('puts quoted text above the message', async () => {
    const { owner } = kit;
    const session = await kit.codexSession();
    await kit.turn(owner, session.id, 'What did you mean here? [[scenario:echo-prompt]]', {
      quote: 'first line\nsecond line',
    });
    expect(assistantTexts(await kit.events(owner, session.id))).toEqual([
      '> first line\n> second line\n\nWhat did you mean here? [[scenario:echo-prompt]]',
    ]);
  });

  it('takes a message into the running turn', async () => {
    const { owner } = kit;
    const session = await kit.codexSession();
    const first = await kit.send(owner, session.id, '[[scenario:steerable]]');
    // The turn is under way once its command shows up.
    await until(
      async () =>
        (await kit.events(owner, session.id)).some((event) => event.type === 'tool.started'),
      { what: 'the turn to be under way' },
    );
    const second = await owner.post<MessageReceipt>(`/api/sessions/${session.id}/messages`, {
      requestId: nextRequestId(),
      text: 'use tabs, not spaces',
      whenBusy: 'steer',
    });
    expect(second.body).toMatchObject({ disposition: 'steered', runId: first.body.runId });
    const run = await kit.runEnded(owner, first.body.runId!);
    expect(run.status).toBe('completed');
    expect(assistantTexts(await kit.events(owner, session.id)).at(-1)).toBe(
      'You steered me: use tabs, not spaces',
    );
  });

  it('stops mid-answer: one terminal event, the text so far kept, no process left', async () => {
    const { owner } = kit;
    const session = await kit.codexSession();
    const live = await kit.connect(owner);
    await live.subscribe(sessionTopic(session.id));
    const sent = await kit.send(owner, session.id, '[[scenario:long 400]]');
    await live.next(
      (frame: ServerFrame) => frame.op === 'event' && frame.type === 'message.delta',
      10_000,
    );
    const pid = (await kit.records()).findLast((record) => record.event === 'app-server')!.pid;
    expect(processExists(pid)).toBe(true);

    const stopped = await owner.post<{ run: Run }>(`/api/sessions/${session.id}/stop`);
    expect(stopped.status).toBe(200);
    const run = await kit.runEnded(owner, sent.body.runId!);
    expect(run).toMatchObject({ status: 'stopped', error: null });
    live.close();

    const events = await kit.events(owner, session.id);
    expect(eventsOf(events, 'run.finished')).toHaveLength(1);
    const partial = eventsOf(events, 'message.assistant');
    expect(partial).toHaveLength(1);
    expect(partial[0]!.data.partial).toBe(true);
    expect(partial[0]!.data.text).toMatch(/^piece 1\. /);
    await until(() => !processExists(pid), { what: 'the CLI process to be gone' });
    // Codex was told to stop the turn, so its own record says "interrupted" and the conversation can go on.
    const after = await kit.turn(owner, session.id, '[[scenario:recall]]');
    expect(after.status).toBe('completed');
  });

  it('stops a command that is running, and a CLI that will not listen', async () => {
    const { owner } = kit;
    const running = async (needle: string): Promise<boolean> => {
      const result = await kit.t.studio.context.processes.run('ps', ['-eo', 'args']);
      return result.stdout
        .split('\n')
        .some((line) => line.includes(needle) && !line.includes('ps -eo'));
    };

    const session = await kit.codexSession();
    const sent = await kit.send(owner, session.id, '[[scenario:read-command sleep 31.4159]]');
    await until(() => running('sleep 31.4159'), {
      what: 'the command to be running',
      timeoutMs: 10_000,
    });
    await owner.post(`/api/sessions/${session.id}/stop`);
    expect((await kit.runEnded(owner, sent.body.runId!)).status).toBe('stopped');
    await until(async () => !(await running('sleep 31.4159')), { what: 'the command to be gone' });

    // A CLI that ignores both the interrupt request and SIGTERM is killed.
    const stubborn = await kit.codexSession();
    const second = await kit.send(owner, stubborn.id, '[[scenario:stubborn]]');
    await until(async () => assistantTexts(await kit.events(owner, stubborn.id)).length > 0, {
      what: 'the stubborn CLI to be talking',
    });
    const pid = (await kit.records()).findLast((record) => record.event === 'app-server')!.pid;
    const before = Date.now();
    await owner.post(`/api/sessions/${stubborn.id}/stop`);
    expect((await kit.runEnded(owner, second.body.runId!)).status).toBe('stopped');
    expect(Date.now() - before).toBeLessThan(4500);
    await until(() => !processExists(pid), { what: 'the stubborn CLI to be gone' });
    expect(eventsOf(await kit.events(owner, stubborn.id), 'run.finished')).toHaveLength(1);
  });

  it("removes Codex's copy of a conversation with the session", async () => {
    const { owner } = kit;
    const session = await kit.codexSession();
    await kit.turn(owner, session.id, 'hello');
    const native = (
      await owner.get<{ nativeSessionId: string }>(`/api/sessions/${session.id}/native-id`)
    ).body.nativeSessionId;
    const file = path.join(kit.standinState, 'threads', `${native}.json`);
    expect(existsSync(file)).toBe(true);
    expect((await owner.delete(`/api/sessions/${session.id}`)).status).toBe(204);
    await until(() => !existsSync(file), { what: "Codex's copy to be removed" });
  });
});
