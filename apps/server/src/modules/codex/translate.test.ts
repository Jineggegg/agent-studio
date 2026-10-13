import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agents/adapter.js';
import { classifyMessage, readItem } from './protocol.js';
import { TurnTranslator, displayPath, fileDiffs, patchPaths, patchPreview, patchTitle, rateLimitInfo, unwrapShellCommand } from './translate.js';

const quiet = { debug: () => {}, warn: () => {} } as unknown as ConstructorParameters<typeof TurnTranslator>[0]['log'];

function translator(extra: { onRateLimits?: (info: unknown) => void } = {}): { events: AgentEvent[]; t: TurnTranslator } {
  const events: AgentEvent[] = [];
  const t = new TurnTranslator({ emit: (event) => events.push(event), log: quiet, cwd: '/work/app', model: 'm-1', bridgeName: 'studio', ...extra });
  t.setMainThread('main');
  return { events, t };
}

describe('unwrapShellCommand', () => {
  it('gives the script inside the shell Codex wraps a command in', () => {
    expect(unwrapShellCommand("/bin/bash -lc 'npm test'")).toBe('npm test');
    expect(unwrapShellCommand('/bin/bash -lc ls')).toBe('ls');
    expect(unwrapShellCommand('bash -c "git status -s"')).toBe('git status -s');
    expect(unwrapShellCommand("/usr/bin/zsh -lc 'echo '\\''quoted'\\'' && ls'")).toBe("echo 'quoted' && ls");
    expect(unwrapShellCommand(`/bin/bash -lc 'echo '"'"'it'"'"' > a.txt'`)).toBe("echo 'it' > a.txt");
    expect(unwrapShellCommand('/bin/bash -lc "say \\"hi\\" \\\\ there"')).toBe('say "hi" \\ there');
  });

  it('leaves alone what it cannot read with certainty', () => {
    // More than one word after -c: the rest are arguments of the script, and the line means more than the script.
    expect(unwrapShellCommand("/bin/bash -lc 'echo $0' extra")).toBe("/bin/bash -lc 'echo $0' extra");
    // Something the shell would expand before the inner shell ever sees it.
    expect(unwrapShellCommand('/bin/bash -lc "rm -rf $TARGET"')).toBe('/bin/bash -lc "rm -rf $TARGET"');
    expect(unwrapShellCommand('/bin/bash -lc "echo `id`"')).toBe('/bin/bash -lc "echo `id`"');
    expect(unwrapShellCommand("/bin/bash -lc 'unterminated")).toBe("/bin/bash -lc 'unterminated");
    expect(unwrapShellCommand('python -c "print(1)"')).toBe('python -c "print(1)"');
    expect(unwrapShellCommand('npm test')).toBe('npm test');
    expect(unwrapShellCommand("/bin/bash -lc ''")).toBe("/bin/bash -lc ''");
  });
});

describe('patches', () => {
  const changes = [
    { path: '/work/app/src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1,3 +1,3 @@\n keep\n-old line\n+new line\n end\n' },
    { path: '/work/app/new.txt', kind: { type: 'add' }, diff: 'hello\nworld\n' },
    { path: '/work/app/gone.txt', kind: { type: 'delete' }, diff: 'bye\n' },
    { path: '/elsewhere/b.ts', kind: { type: 'update', move_path: '/elsewhere/c.ts' }, diff: '@@ -1 +1 @@\n-x\n+y\n' },
  ];

  it('become one diff per file, with paths as a person names them', () => {
    expect(fileDiffs(changes, '/work/app')).toEqual([
      { path: 'src/a.ts', added: 1, removed: 1, patch: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n keep\n-old line\n+new line\n end\n' },
      { path: 'new.txt', added: 2, removed: 0, patch: '--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n' },
      { path: 'gone.txt', added: 0, removed: 1, patch: '--- a/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-bye\n' },
      { path: '/elsewhere/c.ts', added: 1, removed: 1, patch: '--- a//elsewhere/b.ts\n+++ b//elsewhere/c.ts\n@@ -1 +1 @@\n-x\n+y\n' },
    ]);
    expect(patchPreview(changes.slice(0, 2), '/work/app')).toBe('--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n keep\n-old line\n+new line\n end\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n');
  });

  it('name every file they touch, both ends of a move, as absolute paths for the permission engine', () => {
    expect(patchPaths(changes)).toEqual(['/work/app/src/a.ts', '/work/app/new.txt', '/work/app/gone.txt', '/elsewhere/b.ts', '/elsewhere/c.ts']);
  });

  it('get a title that says what happens', () => {
    expect(patchTitle([changes[0]!], '/work/app')).toBe('Edit src/a.ts');
    expect(patchTitle([changes[1]!], '/work/app')).toBe('Create new.txt');
    expect(patchTitle([changes[2]!], '/work/app')).toBe('Delete gone.txt');
    expect(patchTitle([changes[3]!], '/work/app')).toBe('Move /elsewhere/b.ts');
    expect(patchTitle(changes, '/work/app')).toBe('Change src/a.ts, new.txt, gone.txt and 1 more');
    expect(patchTitle([], '/work/app')).toBe('Change files');
  });

  it('show a path inside the project relative to it, and any other as it is', () => {
    expect(displayPath('/work/app/src/x.ts', '/work/app')).toBe('src/x.ts');
    expect(displayPath('/work/application/x.ts', '/work/app')).toBe('/work/application/x.ts');
    expect(displayPath('/work/app', '/work/app')).toBe('/work/app');
    expect(displayPath('relative.txt', '/work/app')).toBe('relative.txt');
    expect(displayPath('/x', null)).toBe('/x');
  });
});

describe('TurnTranslator', () => {
  it('turns a command into one tool call with live output and the exit status', () => {
    const { events, t } = translator();
    const item = { type: 'commandExecution', id: 'c1', command: "/bin/bash -lc 'npm test'", cwd: '/work/app', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null };
    t.notification('item/started', { threadId: 'main', turnId: 't', item });
    // Announced twice (it happens around an approval): still one tool call.
    t.notification('item/started', { threadId: 'main', turnId: 't', item });
    t.notification('item/commandExecution/outputDelta', { threadId: 'main', turnId: 't', itemId: 'c1', delta: '1 failed\n' });
    t.notification('item/completed', { threadId: 'main', turnId: 't', item: { ...item, status: 'failed', aggregatedOutput: '1 failed\n', exitCode: 1 } });
    expect(events).toEqual([
      { type: 'tool.started', toolCallId: 'c1', name: 'shell', kind: 'execute', title: 'npm test', input: { command: 'npm test', cwd: '/work/app' } },
      { type: 'tool.output', toolCallId: 'c1', text: '1 failed\n' },
      { type: 'tool.finished', toolCallId: 'c1', status: 'error', output: '1 failed\n[exit code 1]' },
    ]);
    expect(t.commandOf('c1')).toBe('npm test');
  });

  it('reports a refused item as denied, with what the Studio said', () => {
    const { events, t } = translator();
    const item = { type: 'fileChange', id: 'p1', status: 'inProgress', changes: [{ path: '/work/app/a.txt', kind: { type: 'add' }, diff: 'x\n' }] };
    t.notification('item/started', { threadId: 'main', item });
    expect(t.changesOf('p1')).toHaveLength(1);
    t.noteDenial('p1', 'Plan mode only reads.');
    t.notification('item/completed', { threadId: 'main', item: { ...item, status: 'declined' } });
    expect(events.at(-1)).toEqual({ type: 'tool.finished', toolCallId: 'p1', status: 'denied', output: 'Plan mode only reads.', diffs: [{ path: 'a.txt', added: 1, removed: 0, patch: '--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1,1 @@\n+x\n' }] });
  });

  it("names MCP tools mcp__server__tool, and finds the call a server's approval question is about", () => {
    const { events, t } = translator();
    const call = { type: 'mcpToolCall', id: 'm1', server: 'tracker', tool: 'close_issue', status: 'inProgress', arguments: { id: 7 }, result: null, error: null };
    t.notification('item/started', { threadId: 'main', item: call });
    expect(t.pendingMcpCall('tracker')).toEqual({ itemId: 'm1', tool: 'close_issue' });
    expect(t.pendingMcpCall('studio')).toBeUndefined();
    t.notification('item/completed', { threadId: 'main', item: { ...call, status: 'completed', result: { content: [{ type: 'text', text: 'closed' }, { type: 'image', data: '…' }] } } });
    expect(t.pendingMcpCall('tracker')).toBeUndefined();
    expect(events).toEqual([
      { type: 'tool.started', toolCallId: 'm1', name: 'mcp__tracker__close_issue', kind: 'other', title: 'close_issue (tracker)', input: { id: 7 } },
      { type: 'tool.finished', toolCallId: 'm1', status: 'ok', output: 'closed\n[image]' },
    ]);
  });

  it('streams text and reasoning, joining the parts of a summary as paragraphs', () => {
    const { events, t } = translator();
    t.notification('item/reasoning/summaryPartAdded', { threadId: 'main', itemId: 'r1', summaryIndex: 0 });
    t.notification('item/reasoning/summaryTextDelta', { threadId: 'main', itemId: 'r1', delta: 'First.', summaryIndex: 0 });
    t.notification('item/reasoning/summaryTextDelta', { threadId: 'main', itemId: 'r1', delta: 'Second.', summaryIndex: 1 });
    t.notification('item/completed', { threadId: 'main', item: { type: 'reasoning', id: 'r1', summary: ['First.', 'Second.'], content: [] } });
    t.notification('item/agentMessage/delta', { threadId: 'main', itemId: 'a1', delta: 'Hel' });
    t.notification('item/completed', { threadId: 'main', item: { type: 'agentMessage', id: 'a1', text: 'Hello' } });
    // An empty reasoning item (the model thought, and gave no summary) is not a block.
    t.notification('item/completed', { threadId: 'main', item: { type: 'reasoning', id: 'r2', summary: [], content: [] } });
    expect(events).toEqual([
      { type: 'thinking.delta', messageId: 'r1', text: 'First.' },
      { type: 'thinking.delta', messageId: 'r1', text: '\n\n' },
      { type: 'thinking.delta', messageId: 'r1', text: 'Second.' },
      { type: 'thinking', messageId: 'r1', text: 'First.\n\nSecond.' },
      { type: 'text.delta', messageId: 'a1', text: 'Hel' },
      { type: 'text', messageId: 'a1', text: 'Hello', model: 'm-1' },
    ]);
  });

  it('reports the tokens of each model request once, keeping cached input apart', () => {
    const { events, t } = translator();
    const last = { totalTokens: 1240, inputTokens: 1200, cachedInputTokens: 1000, cacheWriteInputTokens: 50, outputTokens: 40, reasoningOutputTokens: 8 };
    const report = (total: number, thread = 'main', turnId = 't'): void => t.notification('thread/tokenUsage/updated', { threadId: thread, turnId, tokenUsage: { total: { ...last, totalTokens: total }, last, modelContextWindow: 258400 } });
    // A reopened conversation first repeats the figures of its previous turn: they are not this run's.
    report(620, 'main', 'the-turn-before');
    t.notification('turn/started', { threadId: 'main', turn: { id: 't' } });
    t.notification('turn/started', { threadId: 'a-sub-agent', turn: { id: 't' } });
    report(1240);
    report(1240); // the same totals again
    report(2480);
    report(900, 'a-sub-agent');
    const usage = events.filter((event) => event.type === 'usage');
    expect(usage).toHaveLength(3);
    expect(usage[0]).toEqual({ type: 'usage', model: 'm-1', inputTokens: 150, outputTokens: 40, cacheReadTokens: 1000, cacheWriteTokens: 50, contextTokens: 1240, contextWindow: 258400 });
    // A sub-agent's tokens count; its context is not the session's.
    expect(usage[2]).toEqual({ type: 'usage', model: 'm-1', inputTokens: 150, outputTokens: 40, cacheReadTokens: 1000, cacheWriteTokens: 50 });
  });

  it('nests what a sub-agent does under the call that started it', () => {
    const { events, t } = translator();
    const call = { type: 'collabAgentToolCall', id: 's1', tool: 'spawnAgent', status: 'inProgress', receiverThreadIds: [], prompt: 'Check the tests', model: '' };
    t.notification('item/started', { threadId: 'main', item: call });
    t.notification('item/completed', { threadId: 'main', item: { ...call, status: 'completed', receiverThreadIds: ['child'] } });
    t.notification('item/agentMessage/delta', { threadId: 'child', itemId: 'a9', delta: 'ok' });
    t.notification('item/completed', { threadId: 'child', item: { type: 'agentMessage', id: 'a9', text: 'ok' } });
    expect(events.slice(2)).toEqual([
      { type: 'text.delta', messageId: 'a9', text: 'ok', parentToolCallId: 's1' },
      { type: 'text', messageId: 'a9', text: 'ok', model: 'm-1', parentToolCallId: 's1' },
    ]);
  });

  it('keeps the reason of a failure, says once that it is retrying, and passes on rate limits', () => {
    const seen: unknown[] = [];
    const { events, t } = translator({ onRateLimits: (info) => seen.push(info) });
    for (const attempt of [1, 2, 3]) t.notification('error', { error: { message: `Reconnecting... ${attempt}/5`, codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } }, willRetry: true, threadId: 'main', turnId: 't' });
    t.notification('error', { error: { message: 'gave up', codexErrorInfo: 'other' }, willRetry: false, threadId: 'main', turnId: 't' });
    expect(events).toEqual([{ type: 'notice', level: 'warning', code: 'codex_retry', text: 'Codex lost its connection to the model and is trying again.' }]);
    expect(t.lastError).toMatchObject({ message: 'gave up' });

    t.notification('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 17, windowDurationMins: 10080, resetsAt: 1792479518 }, secondary: null, credits: { hasCredits: true, unlimited: false, balance: '12.5' }, planType: 'plus', rateLimitReachedType: null } });
    // A provider without limits reports a snapshot with nothing in it: not worth publishing.
    t.notification('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: null, secondary: null, credits: null, planType: null, rateLimitReachedType: null } });
    expect(seen).toEqual([{ limitId: 'codex', limitName: null, planType: 'plus', primary: { usedPercent: 17, windowMinutes: 10080, resetsAt: 1792479518000 }, secondary: null, credits: { hasCredits: true, unlimited: false, balance: '12.5' }, reached: null }]);
    expect(rateLimitInfo({ primary: null, secondary: null })).toBeNull();
  });

  it('never throws on what it does not know or cannot read', () => {
    const { events, t } = translator();
    t.notification('thread/somethingNew', { whatever: true });
    t.notification('item/started', { threadId: 'main', item: { type: 'holographicProjection', id: 'h1' } });
    t.notification('item/started', { threadId: 'main', item: null });
    t.notification('item/started', 'not an object');
    t.notification('item/agentMessage/delta', { threadId: 'main', itemId: 42, delta: { not: 'text' } });
    t.notification('item/completed', { threadId: 'main', item: { type: 'commandExecution' } });
    t.notification('turn/plan/updated', { threadId: 'main', plan: 'not a list' });
    t.notification('item/commandExecution/outputDelta', { threadId: 'main', itemId: 'never-started', delta: 'x' });
    expect(events).toEqual([]);
  });
});

describe('the message envelope', () => {
  it('tells requests, answers and notifications apart, and rejects what is none of them', () => {
    expect(classifyMessage({ id: 1, result: { ok: true } })).toEqual({ kind: 'response', id: 1, result: { ok: true } });
    expect(classifyMessage({ id: 'a', error: { code: -32600, message: 'no' } })).toEqual({ kind: 'error', id: 'a', code: -32600, message: 'no' });
    expect(classifyMessage({ id: 0, method: 'item/x', params: { a: 1 } })).toEqual({ kind: 'request', id: 0, method: 'item/x', params: { a: 1 } });
    expect(classifyMessage({ method: 'turn/started', params: {}, emittedAtMs: 1 })).toEqual({ kind: 'notification', method: 'turn/started', params: {} });
    for (const junk of [null, 'text', 3, [], {}, { id: 1 }, { id: {}, result: 1 }, { neither: true }]) expect(classifyMessage(junk)).toBeNull();
  });

  it('reads items leniently and returns null for the unknown', () => {
    expect(readItem({ type: 'agentMessage', id: 'a', text: 'hi', phase: null, somethingNew: 1 })).toMatchObject({ type: 'agentMessage', text: 'hi' });
    expect(readItem({ type: 'commandExecution', id: 'c', command: 'ls' })).toMatchObject({ status: 'inProgress', commandActions: [] });
    expect(readItem({ type: 'brandNew', id: 'x' })).toBeNull();
    expect(readItem(undefined)).toBeNull();
  });
});
