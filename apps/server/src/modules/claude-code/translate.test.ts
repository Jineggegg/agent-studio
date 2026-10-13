import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agents/adapter.js';
import { type LineSignal, type ModelTotals, StreamTranslator, type UsageLedger } from './translate.js';

/**
 * The lines below have the shapes Claude Code 2.1.283 printed in the captures
 * described in `docs/guides/agent-smoke-test.md`; ids are shortened and
 * fields nothing reads are left out.
 */

const SESSION = '9d621105-1b0e-408b-a965-6dc8c9c7d9ae';
const CWD = '/work/demo';

function setup(options: { resumed?: boolean; ledger?: UsageLedger } = {}) {
  const events: AgentEvent[] = [];
  const rateLimits: Array<Record<string, unknown>> = [];
  const debug: string[] = [];
  const translator = new StreamTranslator({
    cwd: CWD,
    emit: (event) => events.push(event),
    log: { debug: (_fields, message) => debug.push(message) },
    onRateLimit: (info) => rateLimits.push(info),
    ...options,
  });
  const feed = (...lines: unknown[]): LineSignal[] => lines.map((line) => translator.handle(line));
  return { translator, events, rateLimits, debug, feed };
}

const stream = (event: Record<string, unknown>, parent: string | null = null) => ({ type: 'stream_event', event, session_id: SESSION, parent_tool_use_id: parent, uuid: 'u' });
const usage = (output: number, cacheRead = 14711) => ({ input_tokens: 10, cache_creation_input_tokens: 7359, cache_read_input_tokens: cacheRead, output_tokens: output });
const messageStart = (id: string, model = 'claude-haiku-4-5-20251001') => stream({ type: 'message_start', message: { model, id, type: 'message', role: 'assistant', content: [], usage: usage(3) } });
const blockStart = (index: number, block: Record<string, unknown>) => stream({ type: 'content_block_start', index, content_block: block });
const textDelta = (index: number, text: string) => stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const blockStop = (index: number) => stream({ type: 'content_block_stop', index });
const messageDelta = (output: number, cacheRead?: number) => stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: usage(output, cacheRead) });
const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  message: { model: 'claude-haiku-4-5-20251001', id, type: 'message', role: 'assistant', content, usage: usage(3) },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: 'u',
  ...extra,
});
const toolResult = (id: string, content: unknown, extra: Record<string, unknown> = {}, block: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content, ...block }] },
  parent_tool_use_id: null,
  session_id: SESSION,
  uuid: 'u',
  ...extra,
});
const result = (fields: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'DONE',
  session_id: SESSION,
  total_cost_usd: 0.0203381,
  modelUsage: { 'claude-haiku-4-5-20251001': { inputTokens: 18, outputTokens: 268, cacheReadInputTokens: 36781, cacheCreationInputTokens: 7651, costUSD: 0.0203381, contextWindow: 200000, maxOutputTokens: 32000 } },
  permission_denials: [],
  terminal_reason: 'completed',
  ...fields,
});
const init = { type: 'system', subtype: 'init', cwd: CWD, session_id: SESSION, tools: ['Bash', 'Write'], mcp_servers: [{ name: 'studio', status: 'connected' }], model: 'claude-haiku-4-5-20251001', permissionMode: 'default' };

describe('a turn of the main thread', () => {
  it('translates a file write and the closing sentence, as captured from the real CLI', () => {
    const { translator, events, feed } = setup();
    const signals = feed(
      init,
      { type: 'system', subtype: 'status', status: 'requesting', session_id: SESSION },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Create a.txt' }] }, session_id: SESSION, parent_tool_use_id: null, isReplay: true },
      messageStart('msg_01A'),
      blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
      { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50, session_id: SESSION },
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '', estimated_tokens: 50 } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'EsMF' } }),
      assistant('msg_01A', [{ type: 'thinking', thinking: '', signature: 'EsMF' }]),
      blockStop(0),
      blockStart(1, { type: 'tool_use', id: 'toolu_01C', name: 'Write', input: {} }),
      stream({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"file_path": "/work/demo/a.txt"' } }),
      assistant('msg_01A', [{ type: 'tool_use', id: 'toolu_01C', name: 'Write', input: { file_path: '/work/demo/a.txt', content: 'one' } }]),
      blockStop(1),
      messageDelta(209),
      stream({ type: 'message_stop' }),
      toolResult('toolu_01C', 'File created successfully at: /work/demo/a.txt', { tool_use_result: { type: 'create', filePath: '/work/demo/a.txt', content: 'one', structuredPatch: [], originalFile: null } }),
      messageStart('msg_01B'),
      blockStart(0, { type: 'thinking', thinking: '', signature: '' }),
      assistant('msg_01B', [{ type: 'thinking', thinking: '', signature: 'EtkD' }]),
      blockStop(0),
      blockStart(1, { type: 'text', text: '' }),
      textDelta(1, 'DO'),
      textDelta(1, 'NE'),
      assistant('msg_01B', [{ type: 'text', text: 'DONE' }]),
      blockStop(1),
      messageDelta(59, 22070),
      stream({ type: 'message_stop' }),
      result(),
    );

    expect(signals.map((signal) => signal.kind).filter((kind) => kind !== 'other')).toEqual(['init', 'replay', 'result']);
    expect(translator.sessionId).toBe(SESSION);
    expect(translator.lastResult).toMatchObject({ subtype: 'success', isError: false, text: 'DONE' });
    expect(translator.apiError).toBeNull();
    expect(events).toEqual([
      { type: 'session', nativeSessionId: SESSION },
      { type: 'tool.started', toolCallId: 'toolu_01C', name: 'Write', kind: 'edit', title: 'Write a.txt', input: { file_path: '/work/demo/a.txt', content: 'one' } },
      // One model request done: its usage, and how full the context now is.
      { type: 'usage', model: 'claude-haiku-4-5-20251001', inputTokens: 10, outputTokens: 209, cacheReadTokens: 14711, cacheWriteTokens: 7359, contextTokens: 10 + 14711 + 7359 + 209, cumulative: true },
      { type: 'tool.finished', toolCallId: 'toolu_01C', status: 'ok', output: 'File created successfully at: /work/demo/a.txt', diffs: [{ path: 'a.txt', added: 1, removed: 0, patch: '--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+one\n' }] },
      // Deltas and the completed block carry the same id: the block replaces them.
      { type: 'text.delta', messageId: 'msg_01B:1', text: 'DO' },
      { type: 'text.delta', messageId: 'msg_01B:1', text: 'NE' },
      { type: 'text', messageId: 'msg_01B:1', text: 'DONE', model: 'claude-haiku-4-5-20251001' },
      { type: 'usage', model: 'claude-haiku-4-5-20251001', inputTokens: 20, outputTokens: 268, cacheReadTokens: 36781, cacheWriteTokens: 14718, contextTokens: 10 + 22070 + 7359 + 59, cumulative: true },
      // The CLI's own totals replace the running ones, and bring the cost and the window.
      { type: 'usage', model: 'claude-haiku-4-5-20251001', inputTokens: 18, outputTokens: 268, cacheReadTokens: 36781, cacheWriteTokens: 7651, costUsd: 0.0203381, contextTokens: 10 + 22070 + 7359 + 59, contextWindow: 200000, cumulative: true },
    ]);
  });

  it('emits whole blocks alone when nothing was streamed, each with its own id', () => {
    const { events, feed } = setup();
    feed(assistant('msg_02', [{ type: 'text', text: 'First.' }, { type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'pwd' } }, { type: 'text', text: 'Second.' }]));
    expect(events).toEqual([
      { type: 'text', messageId: 'msg_02:0', text: 'First.', model: 'claude-haiku-4-5-20251001' },
      { type: 'tool.started', toolCallId: 'toolu_02', name: 'Bash', kind: 'execute', title: 'Run pwd', input: { command: 'pwd' } },
      { type: 'text', messageId: 'msg_02:2', text: 'Second.', model: 'claude-haiku-4-5-20251001' },
    ]);
  });

  it('shows reasoning that a model shares, and matches a block to its deltas even when an earlier block was left out', () => {
    const { events, feed } = setup();
    feed(
      messageStart('msg_03'),
      blockStart(0, { type: 'thinking', thinking: '' }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think.' } }),
      assistant('msg_03', [{ type: 'thinking', thinking: 'Let me think.', signature: 's' }]),
      blockStart(1, { type: 'redacted_thinking' }),
      blockStart(2, { type: 'text', text: '' }),
      textDelta(2, 'Four.'),
      // No line was printed for block 1: the text line still belongs to block 2.
      assistant('msg_03', [{ type: 'text', text: 'Four.' }]),
    );
    expect(events).toEqual([
      { type: 'thinking.delta', messageId: 'msg_03:0', text: 'Let me think.' },
      { type: 'thinking', messageId: 'msg_03:0', text: 'Let me think.' },
      { type: 'text.delta', messageId: 'msg_03:2', text: 'Four.' },
      { type: 'text', messageId: 'msg_03:2', text: 'Four.', model: 'claude-haiku-4-5-20251001' },
    ]);
  });

  it('keeps an API failure out of the transcript and remembers it as the reason', () => {
    const { translator, events, feed } = setup();
    feed(
      init,
      { ...assistant('7f3c', [{ type: 'text', text: 'Not logged in · Please run /login' }]), message: { model: '<synthetic>', id: '7f3c', role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, error: 'authentication_failed', is_api_error_message: true },
      result({ is_error: true, result: 'Not logged in · Please run /login', modelUsage: {}, terminal_reason: 'api_error', api_error_status: null }),
    );
    expect(events).toEqual([{ type: 'session', nativeSessionId: SESSION }]);
    expect(translator.apiError).toEqual({ kind: 'authentication_failed', text: 'Not logged in · Please run /login' });
    expect(translator.lastResult).toMatchObject({ isError: true, terminalReason: 'api_error', apiErrorStatus: null });
    expect(translator.producedOutput).toBe(false);
  });
});

describe('tool results', () => {
  const start = (id: string, name: string, input: unknown) => assistant(`msg_${id}`, [{ type: 'tool_use', id, name, input }]);

  it('reports a refusal as denied: by the CLI\'s own marker, or because the Studio said no', () => {
    const { translator, events, feed } = setup();
    feed(start('toolu_a', 'Write', { file_path: '/work/demo/c.txt', content: 'three' }), start('toolu_b', 'Bash', { command: 'rm -rf build' }), start('toolu_c', 'Bash', { command: 'false' }));
    translator.markDenied('toolu_b');
    feed(
      toolResult('toolu_a', 'The reviewer said no: not this file.', { tool_use_result: 'Error: The reviewer said no: not this file.', tool_result_meta: [{ id: 'toolu_a', non_execution_kind: 'permission-rule' }] }, { is_error: true }),
      toolResult('toolu_b', 'Nobody is watching.', {}, { is_error: true }),
      toolResult('toolu_c', 'Exit code 1', {}, { is_error: true }),
    );
    expect(events.filter((event) => event.type === 'tool.finished')).toEqual([
      { type: 'tool.finished', toolCallId: 'toolu_a', status: 'denied', output: 'The reviewer said no: not this file.' },
      { type: 'tool.finished', toolCallId: 'toolu_b', status: 'denied', output: 'Nobody is watching.' },
      { type: 'tool.finished', toolCallId: 'toolu_c', status: 'error', output: 'Exit code 1' },
    ]);
  });

  it('reads content given as blocks, builds a patch from an edit\'s hunks, and finishes a call only once', () => {
    const { events, feed } = setup();
    feed(start('toolu_s', 'ToolSearch', { query: 'select:ExitPlanMode' }), start('toolu_e', 'Edit', { file_path: '/work/demo/src/app.ts', old_string: 'a', new_string: 'b' }));
    const edited = toolResult('toolu_e', 'The file has been updated.', {
      tool_use_result: { filePath: '/work/demo/src/app.ts', structuredPatch: [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [' keep', '-a', '+b', '+c'] }] },
    });
    feed(toolResult('toolu_s', [{ type: 'tool_reference', tool_name: 'ExitPlanMode' }]), edited, edited, toolResult('toolu_unknown', 'never announced'));
    expect(events.filter((event) => event.type === 'tool.finished')).toEqual([
      { type: 'tool.finished', toolCallId: 'toolu_s', status: 'ok', output: '[tool: ExitPlanMode]' },
      { type: 'tool.finished', toolCallId: 'toolu_e', status: 'ok', output: 'The file has been updated.', diffs: [{ path: 'src/app.ts', added: 2, removed: 1, patch: '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -3,2 +3,3 @@\n keep\n-a\n+b\n+c\n' }] },
    ]);
  });

  it('bounds a very large output, keeping both ends', () => {
    const { events, feed } = setup();
    feed(start('toolu_big', 'Bash', { command: 'cat big' }), toolResult('toolu_big', `START${'x'.repeat(900_000)}END`));
    const finished = events.find((event) => event.type === 'tool.finished') as Extract<AgentEvent, { type: 'tool.finished' }>;
    expect(finished.output!.length).toBeLessThan(410_000);
    expect(finished.output!.startsWith('START')).toBe(true);
    expect(finished.output!.endsWith('END')).toBe(true);
    expect(finished.output).toMatch(/characters left out/);
  });

  it('announces a call asked about before its line was read, once, and lets a waiter know', async () => {
    const { translator, events, feed } = setup();
    const waited = translator.waitForTool('toolu_w', 5000);
    feed(start('toolu_w', 'Bash', { command: 'make' }));
    await waited;
    translator.startTool('toolu_w', 'Bash', { command: 'make' });
    // The permission prompt came first here: the call is announced from it, and the line adds nothing.
    translator.startTool('toolu_early', 'Bash', { command: 'make install' });
    feed(start('toolu_early', 'Bash', { command: 'make install' }));
    expect(events.map((event) => (event.type === 'tool.started' ? event.toolCallId : event.type))).toEqual(['toolu_w', 'toolu_early']);
    // Waiting for a call that never comes ends by itself.
    const before = Date.now();
    await translator.waitForTool('toolu_never', 30);
    expect(Date.now() - before).toBeLessThan(1000);
  });
});

describe('sub-agents', () => {
  it('nests a sub-agent\'s blocks under its call and ends that call when the background agent reports', () => {
    const { events, feed } = setup();
    const parent = 'toolu_agent';
    const sub = (line: Record<string, unknown>) => ({ ...line, parent_tool_use_id: parent, subagent_type: 'general-purpose', task_description: 'Run pwd' });
    feed(
      assistant('msg_m1', [{ type: 'tool_use', id: parent, name: 'Agent', input: { description: 'Run pwd', subagent_type: 'general-purpose', prompt: 'Run pwd.' } }]),
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'a83', task_type: 'local_agent' }] },
      { type: 'system', subtype: 'task_started', task_id: 'a83', tool_use_id: parent, description: 'Run pwd', is_backgrounded: true },
      toolResult(parent, [{ type: 'text', text: 'Async agent launched successfully.' }], { tool_use_result: { isAsync: true, status: 'async_launched', agentId: 'a83' } }),
      sub(assistant('msg_s1', [{ type: 'tool_use', id: 'toolu_inner', name: 'Bash', input: { command: 'pwd' } }])),
      { type: 'system', subtype: 'task_progress', task_id: 'a83', tool_use_id: parent, description: 'Running Print working directory' },
      sub(toolResult('toolu_inner', '/work/demo', {}, { is_error: false })),
      assistant('msg_m2', [{ type: 'text', text: 'Waiting for the sub-agent to complete...' }]),
      result({ result: 'Waiting for the sub-agent to complete...' }),
      sub(assistant('msg_s2', [{ type: 'text', text: '/work/demo' }])),
      { type: 'system', subtype: 'task_updated', task_id: 'a83', patch: { status: 'completed' } },
      { type: 'system', subtype: 'task_notification', task_id: 'a83', tool_use_id: parent, status: 'completed', summary: '/work/demo' },
      init,
      assistant('msg_m3', [{ type: 'text', text: 'The sub-agent reported: /work/demo' }]),
      result({ result: 'The sub-agent reported: /work/demo', origin: { kind: 'task-notification' } }),
    );
    expect(events.filter((event) => event.type !== 'usage')).toEqual([
      { type: 'tool.started', toolCallId: parent, name: 'Agent', kind: 'agent', title: 'Sub-agent: Run pwd', input: { description: 'Run pwd', subagent_type: 'general-purpose', prompt: 'Run pwd.' } },
      // "Launched" is not the end of the call.
      { type: 'tool.started', toolCallId: 'toolu_inner', name: 'Bash', kind: 'execute', title: 'Run pwd', input: { command: 'pwd' }, parentToolCallId: parent },
      { type: 'tool.output', toolCallId: parent, text: 'Running Print working directory\n' },
      { type: 'tool.finished', toolCallId: 'toolu_inner', status: 'ok', output: '/work/demo' },
      { type: 'text', messageId: 'msg_m2:0', text: 'Waiting for the sub-agent to complete...', model: 'claude-haiku-4-5-20251001' },
      // (No init line was fed above, so the first result is where the conversation id is learnt.)
      { type: 'session', nativeSessionId: SESSION },
      // After the CLI's first result: the sub-agent's last words, and only then the end of its call.
      { type: 'text', messageId: 'msg_s2:0', text: '/work/demo', model: 'claude-haiku-4-5-20251001', parentToolCallId: parent },
      { type: 'tool.finished', toolCallId: parent, status: 'ok', output: '/work/demo' },
      { type: 'text', messageId: 'msg_m3:0', text: 'The sub-agent reported: /work/demo', model: 'claude-haiku-4-5-20251001' },
    ]);
  });

  it('ends a foreground sub-agent with its result, and a failed background one as an error', () => {
    const { events, feed } = setup();
    feed(
      assistant('msg_f', [{ type: 'tool_use', id: 'toolu_fg', name: 'Task', input: { description: 'Look around' } }]),
      toolResult('toolu_fg', [{ type: 'text', text: 'Nothing unusual.' }], { tool_use_result: { status: 'completed' } }),
      assistant('msg_g', [{ type: 'tool_use', id: 'toolu_bg', name: 'Agent', input: { description: 'Try it' } }]),
      toolResult('toolu_bg', 'launched', { tool_use_result: { isAsync: true } }),
      { type: 'system', subtype: 'task_notification', tool_use_id: 'toolu_bg', status: 'failed' },
      { type: 'system', subtype: 'task_notification', tool_use_id: 'toolu_bg', status: 'failed' },
    );
    expect(events.filter((event) => event.type === 'tool.finished')).toEqual([
      { type: 'tool.finished', toolCallId: 'toolu_fg', status: 'ok', output: 'Nothing unusual.' },
      { type: 'tool.finished', toolCallId: 'toolu_bg', status: 'error', output: 'The sub-agent ended as "failed".' },
    ]);
  });
});

describe('to-do lists', () => {
  const call = (id: string, name: string, input: unknown, content: unknown, structured?: unknown) => [
    assistant(`msg_${id}`, [{ type: 'tool_use', id, name, input }]),
    toolResult(id, content, structured === undefined ? {} : { tool_use_result: structured }),
  ];
  const lists = (events: AgentEvent[]) => events.filter((event) => event.type === 'todos').map((event) => (event as Extract<AgentEvent, { type: 'todos' }>).items);

  it('keeps the list the newer tools change one item at a time', () => {
    const { events, feed } = setup();
    feed(
      ...call('t1', 'TaskCreate', { subject: 'Check directory', description: 'd' }, 'Task #1 created successfully: Check directory', { task: { id: '1', subject: 'Check directory' } }),
      // A sub-agent's result has no structured part: the id is read from the sentence.
      ...call('t2', 'TaskCreate', { subject: 'Report' }, 'Task #2 created successfully: Report'),
      ...call('t3', 'TaskUpdate', { taskId: '1', status: 'in_progress' }, 'Updated task #1 status', { success: true, taskId: '1', statusChange: { from: 'pending', to: 'in_progress' } }),
      ...call('t4', 'TaskUpdate', { taskId: '1', status: 'in_progress' }, 'Updated task #1 status'),
      ...call('t5', 'TaskUpdate', { taskId: '7', status: 'completed' }, 'Updated task #7 status'),
      ...call('t6', 'TaskUpdate', { taskId: '2', status: 'deleted' }, 'Deleted task #2'),
      ...call('t7', 'TaskUpdate', { taskId: '1', subject: 'Check the directory', status: 'completed' }, 'Updated task #1'),
    );
    expect(lists(events)).toEqual([
      [{ text: 'Check directory', status: 'pending' }],
      [{ text: 'Check directory', status: 'pending' }, { text: 'Report', status: 'pending' }],
      [{ text: 'Check directory', status: 'in_progress' }, { text: 'Report', status: 'pending' }],
      // An item from before this process (a resumed conversation) is shown by its number.
      [{ text: 'Check directory', status: 'in_progress' }, { text: 'Report', status: 'pending' }, { text: 'To-do #7', status: 'completed' }],
      [{ text: 'Check directory', status: 'in_progress' }, { text: 'To-do #7', status: 'completed' }],
      [{ text: 'Check the directory', status: 'completed' }, { text: 'To-do #7', status: 'completed' }],
    ]);
  });

  it('takes the whole list from the listing tool and from the older to-do tool', () => {
    const { events, feed } = setup();
    feed(
      ...call('l1', 'TaskList', {}, '2 tasks', { tasks: [{ id: '4', subject: 'Earlier item', status: 'completed' }, { id: '5', subject: 'Next item', status: 'pending' }, { id: 6 }] }),
      ...call('l2', 'TodoWrite', { todos: [{ content: 'Write tests', status: 'in_progress', activeForm: 'Writing tests' }, { content: 'Ship', status: 'pending' }, { content: 'Broken', status: 'someday' }] }, 'Todos have been modified successfully.'),
    );
    expect(lists(events)).toEqual([
      [{ text: 'Earlier item', status: 'completed' }, { text: 'Next item', status: 'pending' }],
      [{ text: 'Write tests', status: 'in_progress' }, { text: 'Ship', status: 'pending' }],
    ]);
  });

  it('leaves the list alone when a to-do tool failed', () => {
    const { events, feed } = setup();
    feed(assistant('msg_x', [{ type: 'tool_use', id: 'tx', name: 'TaskCreate', input: { subject: 'Nope' } }]), toolResult('tx', 'Could not create the task', {}, { is_error: true }));
    expect(lists(events)).toEqual([]);
  });
});

describe('usage', () => {
  it('reports each model the CLI used, the one whose context is known last, and drops a name the CLI does not use', () => {
    const { events, feed } = setup();
    feed(
      { ...init, model: 'claude-sonnet-5' },
      messageStart('msg_u1', 'claude-sonnet-5-internal-name'),
      messageDelta(100, 1000),
      result({
        modelUsage: {
          'claude-sonnet-5': { inputTokens: 8, outputTokens: 537, cacheReadInputTokens: 95078, cacheCreationInputTokens: 32740, costUSD: 0.1553616, contextWindow: 1000000 },
          'claude-haiku-4-5-20251001': { inputTokens: 10, outputTokens: 94, cacheReadInputTokens: 43348, cacheCreationInputTokens: 5949, costUSD: 0.0167128, contextWindow: 200000 },
        },
      }),
    );
    const usages = events.filter((event) => event.type === 'usage');
    expect(usages).toEqual([
      { type: 'usage', model: 'claude-sonnet-5-internal-name', inputTokens: 10, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 7359, contextTokens: 8469, cumulative: true },
      // The streamed name is not one the CLI totals under: zeroed, so nothing is counted twice.
      { type: 'usage', model: 'claude-sonnet-5-internal-name', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 8469, cumulative: true },
      { type: 'usage', model: 'claude-haiku-4-5-20251001', inputTokens: 10, outputTokens: 94, cacheReadTokens: 43348, cacheWriteTokens: 5949, costUsd: 0.0167128, contextWindow: 200000, cumulative: true },
      // The session's model carries the context figure and comes last.
      { type: 'usage', model: 'claude-sonnet-5', inputTokens: 8, outputTokens: 537, cacheReadTokens: 95078, cacheWriteTokens: 32740, costUsd: 0.1553616, contextTokens: 8469, contextWindow: 1000000, cumulative: true },
    ]);
  });

  it('keeps cost and window on the reports of a later turn of the same process', () => {
    const { events, feed } = setup();
    feed(init, messageStart('msg_v1'), messageDelta(50), result(), messageStart('msg_v2'), messageDelta(70));
    const last = events.filter((event) => event.type === 'usage').at(-1);
    expect(last).toMatchObject({ inputTokens: 28, outputTokens: 338, costUsd: 0.0203381, contextWindow: 200000, cumulative: true });
  });

  it('reports nothing for a result without usage (a turn that never reached the model)', () => {
    const { events, feed } = setup();
    feed(result({ subtype: 'error_during_execution', is_error: true, modelUsage: {}, errors: ['No conversation found with session ID: 1111'], result: undefined }));
    expect(events).toEqual([]);
  });
});

describe('usage of a resumed conversation', () => {
  const HAIKU = 'claude-haiku-4-5-20251001';
  const ledgerWith = (entries: Array<[string, Record<string, ModelTotals>]> = []) => {
    const stored = new Map<string, ReadonlyMap<string, ModelTotals>>(entries.map(([id, models]) => [id, new Map(Object.entries(models))]));
    const ledger: UsageLedger = { get: (id) => stored.get(id), set: (id, totals) => void stored.set(id, totals) };
    return { ledger, stored };
  };
  // What the real CLI printed for the second turn of a conversation: totals that include the first turn.
  const secondTurn = result({ total_cost_usd: 0.0329492, modelUsage: { [HAIKU]: { inputTokens: 44, outputTokens: 789, cacheReadInputTokens: 107382, cacheCreationInputTokens: 9111, costUSD: 0.0329492, contextWindow: 200000 } } });
  const afterFirstTurn: ModelTotals = { input: 18, output: 382, cacheRead: 37362, cacheWrite: 8339, cost: 0.0223422 };

  it('reports what this run added to the conversation\'s totals, and remembers where the conversation now stands', () => {
    const { ledger, stored } = ledgerWith([[SESSION, { [HAIKU]: afterFirstTurn, 'claude-sonnet-5': { input: 8, output: 537, cacheRead: 95078, cacheWrite: 32740, cost: 0.1553616 } }]]);
    const { events, feed } = setup({ resumed: true, ledger });
    feed(init, messageStart('msg_r1'), messageDelta(407, 23647), {
      ...secondTurn,
      // A model an earlier turn used and this one did not: its totals have not moved.
      modelUsage: { ...(secondTurn.modelUsage as object), 'claude-sonnet-5': { inputTokens: 8, outputTokens: 537, cacheReadInputTokens: 95078, cacheCreationInputTokens: 32740, costUSD: 0.1553616, contextWindow: 1000000 } },
    });
    expect(events.filter((event) => event.type === 'usage').at(-1)).toEqual({
      type: 'usage',
      model: HAIKU,
      inputTokens: 44 - 18,
      outputTokens: 789 - 382,
      cacheReadTokens: 107382 - 37362,
      cacheWriteTokens: 9111 - 8339,
      costUsd: 0.010607,
      contextTokens: 10 + 23647 + 7359 + 407,
      contextWindow: 200000,
      cumulative: true,
    });
    expect(events.filter((event) => event.type === 'usage' && event.model === 'claude-sonnet-5')).toEqual([]);
    expect(stored.get(SESSION)!.get(HAIKU)).toEqual({ input: 44, output: 789, cacheRead: 107382, cacheWrite: 9111, cost: 0.0329492 });
  });

  it('reports the streamed tokens and no cost when nobody knows where the conversation stood', () => {
    const { ledger, stored } = ledgerWith();
    const { events, feed } = setup({ resumed: true, ledger });
    feed(init, messageStart('msg_r2'), messageDelta(407, 23647), secondTurn, messageStart('msg_r3'), messageDelta(5, 100), result({ modelUsage: { [HAIKU]: { inputTokens: 54, outputTokens: 794, cacheReadInputTokens: 107482, cacheCreationInputTokens: 16470, costUSD: 0.04, contextWindow: 200000 } } }));
    const usages = events.filter((event) => event.type === 'usage');
    expect(usages.every((event) => !('costUsd' in event))).toBe(true);
    // The window is still learnt, and the tokens are those of this process's own requests.
    expect(usages.at(-1)).toEqual({ type: 'usage', model: HAIKU, inputTokens: 20, outputTokens: 412, cacheReadTokens: 23747, cacheWriteTokens: 14718, contextTokens: 10 + 100 + 7359 + 5, contextWindow: 200000, cumulative: true });
    // The next run of this conversation will know.
    expect(stored.get(SESSION)!.get(HAIKU)).toMatchObject({ input: 54, cost: 0.04 });
  });

  it('starts from zero for a new conversation, whatever a ledger holds under that id', () => {
    const { ledger } = ledgerWith([[SESSION, { [HAIKU]: afterFirstTurn }]]);
    const { events, feed } = setup({ resumed: false, ledger });
    feed(init, secondTurn);
    expect(events.filter((event) => event.type === 'usage')).toEqual([{ type: 'usage', model: HAIKU, inputTokens: 44, outputTokens: 789, cacheReadTokens: 107382, cacheWriteTokens: 9111, costUsd: 0.0329492, contextWindow: 200000, cumulative: true }]);
  });

  it('keeps the streamed figures when the totals do not line up with what was remembered', () => {
    const { ledger } = ledgerWith([[SESSION, { [HAIKU]: { input: 5000, output: 9000, cacheRead: 1, cacheWrite: 1, cost: 9 } }]]);
    const { events, debug, feed } = setup({ resumed: true, ledger });
    feed(init, messageStart('msg_r4'), messageDelta(50), secondTurn);
    expect(events.filter((event) => event.type === 'usage')).toEqual([{ type: 'usage', model: HAIKU, inputTokens: 10, outputTokens: 50, cacheReadTokens: 14711, cacheWriteTokens: 7359, contextTokens: 10 + 14711 + 7359 + 50, cumulative: true }]);
    expect(debug.join('\n')).toMatch(/totals went down/);
  });
});

describe('an interrupted answer', () => {
  it('is left as the deltas that were streamed: the block the CLI marks as cut short is not stored as complete', () => {
    const { events, feed } = setup();
    feed(
      messageStart('msg_i1'),
      blockStart(0, { type: 'text', text: '' }),
      textDelta(0, 'one\ntwo\n'),
      textDelta(0, 'three'),
      // Captured from the real CLI after an interrupt: the partial text, flagged.
      assistant('msg_i1', [{ type: 'text', text: 'one\ntwo\nthree' }], { aborted: true }),
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null, session_id: SESSION },
      result({ subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', errors: ['[ede_diagnostic] result_type=user'], result: undefined }),
    );
    expect(events.filter((event) => event.type === 'text' || event.type === 'text.delta')).toEqual([
      { type: 'text.delta', messageId: 'msg_i1:0', text: 'one\ntwo\n' },
      { type: 'text.delta', messageId: 'msg_i1:0', text: 'three' },
    ]);
  });

  it('is still kept when nothing of it was streamed', () => {
    const { events, feed } = setup();
    feed(assistant('msg_i2', [{ type: 'text', text: 'half an ans' }], { aborted: true }));
    expect(events).toEqual([{ type: 'text', messageId: 'msg_i2:0', text: 'half an ans', model: 'claude-haiku-4-5-20251001' }]);
  });
});

describe('notices and limits', () => {
  const rate = (info: Record<string, unknown>) => ({ type: 'rate_limit_event', rate_limit_info: info, uuid: 'u', session_id: SESSION });

  it('hands every rate-limit report on, and tells the user once per state that is not "allowed"', () => {
    const { events, rateLimits, feed } = setup();
    const allowed = { status: 'allowed', resetsAt: 1791939600, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.37, resetsAt: 1791939600 } } };
    feed(
      rate(allowed),
      rate({ ...allowed, status: 'allowed_warning' }),
      rate({ ...allowed, status: 'allowed_warning' }),
      rate({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1792389600 }),
      rate({ status: 'rejected', rateLimitType: 'something_new' }),
      rate(allowed),
      rate({ ...allowed, status: 'allowed_warning' }),
      { type: 'rate_limit_event' },
    );
    expect(rateLimits).toHaveLength(7);
    expect(rateLimits[0]).toEqual(allowed);
    expect(events).toEqual([
      { type: 'notice', level: 'warning', code: 'rate_limit_warning', text: "Claude's five-hour usage limit is close; it resets at 2026-10-14 01:00 UTC." },
      { type: 'notice', level: 'error', code: 'rate_limit', text: "Claude's weekly usage limit has been reached; it resets at 2026-10-19 06:00 UTC." },
      { type: 'notice', level: 'error', code: 'rate_limit', text: "Claude's something new usage limit has been reached." },
      { type: 'notice', level: 'warning', code: 'rate_limit_warning', text: "Claude's five-hour usage limit is close; it resets at 2026-10-14 01:00 UTC." },
    ]);
  });

  it('reports a compaction once, and a bounded number of API retries', () => {
    const { events, feed } = setup();
    feed(
      { type: 'system', subtype: 'status', status: 'compacting' },
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 150000 } },
      messageStart('msg_c1'),
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 180000 } },
      ...Array.from({ length: 8 }, (_unused, index) => ({ type: 'system', subtype: 'api_retry', attempt: index + 1, max_retries: 10, retry_delay_ms: 500, error_status: 529 })),
      { type: 'system', subtype: 'api_retry' },
    );
    const notices = events.filter((event) => event.type === 'notice') as Array<Extract<AgentEvent, { type: 'notice' }>>;
    expect(notices.map((notice) => notice.code)).toEqual(['compaction', 'compaction', 'api_retry', 'api_retry', 'api_retry', 'api_retry', 'api_retry']);
    expect(notices[0]!.text).toMatch(/is summarising/);
    expect(notices[1]!.text).toContain('180,000 tokens');
    expect(notices[2]).toEqual({ type: 'notice', level: 'warning', code: 'api_retry', text: 'The model service did not answer (HTTP 529); Claude Code is trying again (attempt 1 of 10).' });
  });
});

describe('everything else', () => {
  it('tells the driver about control messages and ignores what it does not know, without throwing', () => {
    const { events, debug, feed } = setup();
    const signals = feed(
      { type: 'control_response', response: { subtype: 'success', request_id: 'stop-1', response: { still_queued: [] } } },
      { type: 'control_request', request_id: 'req-9', request: { subtype: 'can_use_tool', tool_name: 'Bash' } },
      { type: 'control_request' },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }, parent_tool_use_id: null },
      { type: 'user', message: { role: 'user', content: 'plain text' } },
      { type: 'future_event', payload: 1 },
      { type: 'system', subtype: 'future_subtype' },
      stream({ type: 'future_stream_event' }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'orphan' } }),
      { type: 'assistant' },
      { type: 'result' },
      'a string',
      null,
      42,
      [],
      {},
    );
    expect(signals.map((signal) => signal.kind)).toEqual(['control_response', 'control_request', 'control_request', 'other', 'other', 'other', 'other', 'other', 'other', 'other', 'result', 'other', 'other', 'other', 'other', 'other']);
    expect(signals[0]).toEqual({ kind: 'control_response', requestId: 'stop-1' });
    expect(signals[1]).toEqual({ kind: 'control_request', requestId: 'req-9', subtype: 'can_use_tool' });
    expect(signals[2]).toEqual({ kind: 'control_request', requestId: null, subtype: null });
    expect(events).toEqual([]);
    expect(debug.length).toBeGreaterThanOrEqual(6);
    // What is logged about an unknown line is its type, never its content.
    expect(debug.join('\n')).not.toContain('orphan');
  });

  it('takes the conversation id from a result when no init line carried it, but not from a failed one', () => {
    const fresh = setup();
    fresh.feed(result({ session_id: 'aaaa' }));
    expect(fresh.events[0]).toEqual({ type: 'session', nativeSessionId: 'aaaa' });
    const failed = setup();
    failed.feed(result({ session_id: 'bbbb', is_error: true, subtype: 'error_during_execution', modelUsage: {} }));
    expect(failed.events).toEqual([]);
    expect(failed.translator.sessionId).toBeNull();
  });
});
