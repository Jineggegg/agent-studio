import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MemoryListResponse, PermissionRule, Provider, Run, SessionEvent } from '@agent-studio/protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FakeToolCall } from '../../src/modules/providers/testing/fake-openai.js';
import { type ProvidersKit, createProvidersKit, eventsOf } from '../../src/modules/providers/testing/providers-kit.js';
import { nextRequestId, until } from '../../src/testing/agents-kit.js';

type ErrorBody = { error: { code: string; message: string } };
type ToolMessage = { role: string; content: string; tool_call_id?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>; reasoning_content?: string };

let kit: ProvidersKit;
let provider: Provider;

beforeAll(async () => {
  kit = await createProvidersKit();
  provider = await kit.provider();
  writeFileSync(kit.file('notes.txt'), 'alpha\nbeta\ngamma\n');
  mkdirSync(kit.file('src'));
  writeFileSync(kit.file('src', 'app.ts'), 'export const answer = 42;\n// TODO: tidy up\n');
});
afterAll(async () => {
  await kit.close();
});
beforeEach(() => {
  kit.model.reset();
});

const call = (name: string, args: unknown, id?: string): FakeToolCall => ({ name, arguments: args, ...(id ? { id } : {}) });
/** The messages of the n-th chat request the model server received. */
const sent = (target: ProvidersKit, index = -1): ToolMessage[] => target.model.chats.at(index)!.body.messages;
/** The tool results the model was given in its newest request, in order. */
const results = (target: ProvidersKit = kit, index = -1): string[] =>
  sent(target, index)
    .filter((message) => message.role === 'tool')
    .map((message) => message.content);
const types = (events: SessionEvent[]): string[] => events.map((event) => event.type);
const noticeCodes = (events: SessionEvent[]): string[] => eventsOf(events, 'notice').map((notice) => notice.code);

/** A run that ended by itself: one that had asked for approval would still be waiting. */
const finished = (run: Run): void => {
  expect(run.status).toBe('completed');
};

describe('reading and searching', () => {
  it('carries out several tool calls of one answer in order, without asking, and hands the results back', async () => {
    const session = await kit.session(provider);
    kit.model.script(
      {
        reasoning: 'I should look at the notes first.',
        text: 'Let me look.',
        toolCalls: [
          { id: 'call_a', name: 'read_file', arguments: { path: 'notes.txt' }, pieces: 7 },
          { id: 'call_b', name: 'list_directory', arguments: {} },
          { id: 'call_c', name: 'find_files', arguments: { pattern: '*.ts' }, pieces: 1 },
          { id: 'call_d', name: 'search_text', arguments: { query: 'todo' } },
        ],
        usage: { prompt_tokens: 900, completion_tokens: 60 },
      },
      { text: 'The notes list three Greek letters.', usage: { prompt_tokens: 1100, completion_tokens: 12 } },
    );
    finished(await kit.turn(kit.owner, session.id, 'What is in this project?'));
    expect(kit.model.chats).toHaveLength(2);

    // The second request continues the first: the assistant's calls, then one result per call, in order.
    const messages = sent(kit);
    const assistant = messages.at(-5)!;
    expect(assistant).toMatchObject({ role: 'assistant', content: 'Let me look.', reasoning_content: 'I should look at the notes first.' });
    expect(assistant.tool_calls!.map((entry) => [entry.id, entry.function.name, JSON.parse(entry.function.arguments)])).toEqual([
      ['call_a', 'read_file', { path: 'notes.txt' }],
      ['call_b', 'list_directory', {}],
      ['call_c', 'find_files', { pattern: '*.ts' }],
      ['call_d', 'search_text', { query: 'todo' }],
    ]);
    expect(messages.slice(-4).map((message) => [message.role, message.tool_call_id])).toEqual([['tool', 'call_a'], ['tool', 'call_b'], ['tool', 'call_c'], ['tool', 'call_d']]);
    const [read, list, find, search] = results();
    expect(read).toBe('notes.txt — lines 1–3 of 3.\n\nalpha\nbeta\ngamma');
    expect(list).toContain('src/\nnotes.txt  (17 bytes)');
    expect(find).toBe('1 file match "*.ts".\nsrc/app.ts');
    expect(search).toBe('1 match in 1 file.\nsrc/app.ts:2: // TODO: tidy up');

    const events = await kit.events(kit.owner, session.id);
    expect(types(events)).toEqual([
      'message.user',
      'run.started',
      'thinking',
      'message.assistant',
      'usage.reported',
      'tool.started',
      'tool.finished',
      'tool.started',
      'tool.finished',
      'tool.started',
      'tool.finished',
      'tool.started',
      'tool.finished',
      'message.assistant',
      'usage.reported',
      'run.finished',
    ]);
    const started = eventsOf(events, 'tool.started');
    expect(started.map((tool) => [tool.name, tool.kind, tool.title])).toEqual([
      ['read_file', 'read', 'Read notes.txt'],
      ['list_directory', 'read', 'List the working directory'],
      ['find_files', 'search', 'Find *.ts'],
      ['search_text', 'search', 'Search for "todo"'],
    ]);
    expect(new Set(started.map((tool) => tool.toolCallId)).size).toBe(4);
    expect(eventsOf(events, 'tool.finished').map((tool) => tool.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(eventsOf(events, 'tool.finished')[0]).toMatchObject({ toolCallId: started[0].toolCallId, output: read });
    // Usage adds up over the requests of the run.
    expect(eventsOf(events, 'usage.reported').at(-1)).toMatchObject({ inputTokens: 2000, outputTokens: 72 });

    // The reasoning was handed back inside the turn only: the next turn starts from the plain conversation.
    kit.model.script({ text: 'You are welcome.' });
    await kit.turn(kit.owner, session.id, 'thanks');
    expect(sent(kit).slice(1)).toEqual([
      { role: 'user', content: 'What is in this project?' },
      { role: 'assistant', content: 'Let me look.\n\nThe notes list three Greek letters.' },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('reads long files in parts, describes binary files, and says what does not exist', async () => {
    writeFileSync(kit.file('long.txt'), Array.from({ length: 50 }, (_unused, index) => `row ${index + 1}`).join('\n'));
    writeFileSync(kit.file('image.bin'), Buffer.from([137, 80, 78, 71, 0, 0, 0, 13]));
    const session = await kit.session(provider);
    kit.model.script(
      {
        toolCalls: [
          call('read_file', { path: 'long.txt', offset: 10, limit: 3 }),
          call('read_file', { path: 'long.txt', offset: 49 }),
          call('read_file', { path: 'long.txt', offset: 500 }),
          call('read_file', { path: 'image.bin' }),
          call('read_file', { path: 'missing.txt' }),
          call('read_file', { path: 'src' }),
          call('list_directory', { path: 'src/app.ts' }),
          call('read_file', { path: kit.file('notes.txt') }),
          call('search_text', { query: 'ANSWER', path: 'src', case_sensitive: true }),
          call('search_text', { query: 'answer', glob: '*.md' }),
          call('find_files', { pattern: 'SRC/*.TS' }),
        ],
      },
      { text: 'done' },
    );
    finished(await kit.turn(kit.owner, session.id, 'look around'));
    const [part, tail, beyond, binary, missing, directory, file, absolute, sensitive, filtered, byPath] = results();
    expect(part).toBe('long.txt — lines 10–12 of 50. Continue with offset 13.\n\nrow 10\nrow 11\nrow 12');
    expect(tail).toBe('long.txt — lines 49–50 of 50.\n\nrow 49\nrow 50');
    expect(beyond).toBe('"long.txt" has only 50 lines.');
    expect(binary).toBe('"image.bin" is a binary file (8 bytes). Its content is not shown.');
    expect(missing).toBe('Error: There is no file "missing.txt".');
    expect(directory).toBe('Error: "src" is a directory. Use list_directory.');
    expect(file).toBe('Error: "src/app.ts" is a file. Use read_file.');
    // An absolute path inside the project is as good as a relative one.
    expect(absolute).toContain('alpha\nbeta\ngamma');
    expect(sensitive).toBe('Nothing matches "ANSWER".');
    expect(filtered).toBe('Nothing matches "answer".');
    expect(byPath).toBe('1 file match "SRC/*.TS".\nsrc/app.ts');
  });

  it('asks before reading what looks like credentials, even inside the project', async () => {
    writeFileSync(kit.file('.env'), 'DATABASE_PASSWORD=hunter2hunter2\n');
    const session = await kit.session(provider);
    kit.model.script({ toolCalls: [call('read_file', { path: '.env' })] }, { text: 'I was not allowed to read it.' });
    const sentMessage = await kit.send(kit.owner, session.id, 'what is the database password?');
    const [approval] = await kit.pending(kit.owner, session.id);
    expect(approval).toMatchObject({ toolName: 'read_file', toolKind: 'read', risk: 'dangerous', riskCategories: ['credentials'], paths: [kit.file('.env')], suggestedRule: null });
    await kit.decide(kit.owner, approval!.id, { decision: 'deny' });
    finished(await kit.runEnded(kit.owner, sentMessage.body.runId!));
    expect(results()[0]).toContain('Denied:');
    expect(JSON.stringify(kit.model.chats)).not.toContain('hunter2');
  });
});

describe('changing files', () => {
  it('shows the diff of an edit for approval, and changes the file only when it is allowed', async () => {
    const session = await kit.session(provider);
    kit.model.script(
      { toolCalls: [call('edit_file', { path: 'notes.txt', old_string: 'beta', new_string: 'BETA' }, 'call_edit')] },
      { toolCalls: [call('edit_file', { path: 'notes.txt', old_string: 'gamma', new_string: 'GAMMA' })] },
      { text: 'One edit was made, one refused.' },
    );
    const message = await kit.send(kit.owner, session.id, 'shout the Greek letters');
    const [first] = await kit.pending(kit.owner, session.id);
    expect(first).toMatchObject({
      kind: 'tool',
      toolName: 'edit_file',
      toolKind: 'edit',
      title: 'Edit notes.txt',
      risk: 'medium',
      paths: [kit.file('notes.txt')],
      command: null,
      suggestedRule: { tool: 'edit_file', pattern: null },
      input: { path: 'notes.txt', old_string: 'beta', new_string: 'BETA' },
    });
    expect(first!.diff).toBe(['--- a/notes.txt', '+++ b/notes.txt', '@@ -1,3 +1,3 @@', ' alpha', '-beta', '+BETA', ' gamma'].join('\n'));
    // Nothing happened yet.
    expect(readFileSync(kit.file('notes.txt'), 'utf8')).toBe('alpha\nbeta\ngamma\n');
    expect(kit.model.chats).toHaveLength(1);

    await kit.decide(kit.owner, first!.id, { decision: 'allow' });
    const second = await until(async () => (await kit.pending(kit.owner, session.id)).find((approval) => approval.id !== first!.id), { what: 'the second approval' });
    expect(readFileSync(kit.file('notes.txt'), 'utf8')).toBe('alpha\nBETA\ngamma\n');
    await kit.decide(kit.owner, second.id, { decision: 'deny', note: 'leave gamma alone' });
    finished(await kit.runEnded(kit.owner, message.body.runId!));
    expect(readFileSync(kit.file('notes.txt'), 'utf8')).toBe('alpha\nBETA\ngamma\n');

    expect(results(kit, 1)).toEqual(['Edited "notes.txt" (+1 −1 lines).']);
    expect(results(kit, 2).at(-1)).toBe('Denied: leave gamma alone Do not send this call again; continue another way, or tell the user what you would need.');
    const events = await kit.events(kit.owner, session.id);
    expect(types(events)).toEqual([
      'message.user',
      'run.started',
      'tool.started',
      'approval.requested',
      'approval.resolved',
      'tool.finished',
      'tool.started',
      'approval.requested',
      'approval.resolved',
      'tool.finished',
      'message.assistant',
      'run.finished',
    ]);
    const [done, refused] = eventsOf(events, 'tool.finished');
    expect(done).toMatchObject({ status: 'ok', diffs: [{ path: 'notes.txt', added: 1, removed: 1 }] });
    expect(done.diffs[0].patch).toContain('-beta\n+BETA');
    expect(refused).toMatchObject({ status: 'denied', output: 'leave gamma alone', diffs: [] });
    // The approval is tied to the tool call it is about.
    expect(first!.toolCallId).toBe(eventsOf(events, 'tool.started')[0].toolCallId);
    writeFileSync(kit.file('notes.txt'), 'alpha\nbeta\ngamma\n');
  });

  it('refuses an edit that is not exact, before anybody is asked', async () => {
    writeFileSync(kit.file('twice.txt'), 'one\ntwo\none\n');
    const session = await kit.session(provider, kit.owner, { permissionMode: 'accept-edits' });
    kit.model.script(
      {
        toolCalls: [
          call('edit_file', { path: 'twice.txt', old_string: 'three', new_string: '3' }),
          call('edit_file', { path: 'twice.txt', old_string: 'one', new_string: '1' }),
          call('edit_file', { path: 'twice.txt', old_string: 'one', new_string: 'one' }),
          call('edit_file', { path: 'nowhere.txt', old_string: 'a', new_string: 'b' }),
          call('edit_file', { path: 'twice.txt', old_string: 'one', new_string: '1', replace_all: true }),
        ],
      },
      { text: 'done' },
    );
    finished(await kit.turn(kit.owner, session.id, 'fix the numbers'));
    const [notFound, ambiguous, same, missing, all] = results();
    expect(notFound).toContain('Error: old_string was not found in "twice.txt"');
    expect(ambiguous).toContain('Error: old_string occurs 2 times in "twice.txt"');
    expect(same).toContain('there is nothing to change');
    expect(missing).toContain('Error: There is no file "nowhere.txt". Use write_file');
    expect(all).toBe('Edited "twice.txt" (+2 −2 lines).');
    expect(readFileSync(kit.file('twice.txt'), 'utf8')).toBe('1\ntwo\n1\n');
  });

  it('writes files without asking in accept-edits mode, creating directories as needed', async () => {
    const session = await kit.session(provider, kit.owner, { permissionMode: 'accept-edits' });
    kit.model.script(
      { toolCalls: [call('write_file', { path: 'docs/guide/intro.md', content: '# Intro\n\nWelcome.\n' }), call('write_file', { path: 'notes.txt', content: 'alpha\nbeta\ngamma\ndelta\n' })] },
      { text: 'Written.' },
    );
    finished(await kit.turn(kit.owner, session.id, 'write the docs'));
    expect(readFileSync(kit.file('docs', 'guide', 'intro.md'), 'utf8')).toBe('# Intro\n\nWelcome.\n');
    expect(readFileSync(kit.file('notes.txt'), 'utf8')).toBe('alpha\nbeta\ngamma\ndelta\n');
    expect(results()).toEqual(['Created "docs/guide/intro.md" (3 lines).', 'Replaced "notes.txt" (+1 −0 lines).']);
    const events = await kit.events(kit.owner, session.id);
    expect(types(events)).not.toContain('approval.requested');
    const [created, replaced] = eventsOf(events, 'tool.finished');
    expect(created.diffs).toEqual([{ path: 'docs/guide/intro.md', added: 3, removed: 0, patch: '--- /dev/null\n+++ b/docs/guide/intro.md\n@@ -0,0 +1,3 @@\n+# Intro\n+\n+Welcome.' }]);
    expect(replaced.diffs[0]).toMatchObject({ path: 'notes.txt', added: 1, removed: 0 });
    expect(eventsOf(events, 'tool.started').map((tool) => [tool.kind, tool.title])).toEqual([['edit', 'Create docs/guide/intro.md'], ['edit', 'Replace notes.txt']]);
    writeFileSync(kit.file('notes.txt'), 'alpha\nbeta\ngamma\n');
  });

  it('changes nothing in plan mode: the engine refuses, nobody is asked', async () => {
    const session = await kit.session(provider, kit.owner, { permissionMode: 'plan' });
    kit.model.script(
      {
        toolCalls: [
          call('read_file', { path: 'notes.txt' }),
          call('write_file', { path: 'plan-mode.txt', content: 'should not exist' }),
          call('edit_file', { path: 'notes.txt', old_string: 'alpha', new_string: 'omega' }),
          call('run_command', { command: 'touch plan-mode-ran.txt' }),
        ],
      },
      { text: 'Here is my plan: …' },
    );
    finished(await kit.turn(kit.owner, session.id, 'plan the change'));
    const [read, write, edit, command] = results();
    expect(read).toContain('alpha\nbeta\ngamma');
    for (const refused of [write, edit, command]) expect(refused).toContain('Denied: Plan mode only reads and searches');
    expect(existsSync(kit.file('plan-mode.txt'))).toBe(false);
    expect(existsSync(kit.file('plan-mode-ran.txt'))).toBe(false);
    expect(readFileSync(kit.file('notes.txt'), 'utf8')).toBe('alpha\nbeta\ngamma\n');
    const events = await kit.events(kit.owner, session.id);
    expect(types(events)).not.toContain('approval.requested');
    expect(eventsOf(events, 'tool.finished').map((tool) => tool.status)).toEqual(['ok', 'denied', 'denied', 'denied']);
    expect(String(sent(kit, 0)[0]!.content)).toContain('The session is in plan mode');
  });

  it('denies what would need approval in a run nobody is watching', async () => {
    const session = await kit.session(provider);
    const agents = kit.t.studio.context.services.agents;
    const principal = agents.principalFor(kit.owner.userId!)!;
    kit.model.script({ toolCalls: [call('read_file', { path: 'notes.txt' }), call('write_file', { path: 'nightly.txt', content: 'report' }), call('run_command', { command: 'touch nightly-ran.txt' })] }, { text: 'I could only read.' });
    const receipt = await agents.sendMessage(principal, session.id, { requestId: nextRequestId(), text: 'nightly report' }, { origin: 'scheduled' });
    const run = await kit.runEnded(kit.owner, receipt.runId!);
    expect(run).toMatchObject({ status: 'completed', unattended: true });
    const [read, write, command] = results();
    expect(read).toContain('alpha');
    expect(write).toContain('Denied: This needs approval, and nobody is watching an unattended run.');
    expect(command).toContain('Denied: This needs approval, and nobody is watching an unattended run.');
    expect(existsSync(kit.file('nightly.txt'))).toBe(false);
    expect(existsSync(kit.file('nightly-ran.txt'))).toBe(false);
    const events = await kit.events(kit.owner, session.id);
    expect(types(events)).not.toContain('approval.requested');
    expect(noticeCodes(events)).toContain('approval_skipped');
    expect(String(sent(kit, 0)[0]!.content)).toContain('Nobody is watching this run');
  });
});

describe('running commands', () => {
  it('asks, runs when allowed, remembers when told to, and reports how the command ended', async () => {
    const session = await kit.session(provider);
    kit.model.script(
      { toolCalls: [call('run_command', { command: 'echo hello world' }, 'call_run')] },
      { toolCalls: [call('run_command', { command: 'echo "hello   again"' })] },
      { toolCalls: [call('run_command', { command: 'ls src' })] },
      { text: 'Two commands ran.' },
    );
    const message = await kit.send(kit.owner, session.id, 'say hello');
    const [approval] = await kit.pending(kit.owner, session.id);
    expect(approval).toMatchObject({
      toolName: 'run_command',
      toolKind: 'execute',
      title: 'Run echo hello world',
      command: 'echo hello world',
      risk: 'medium',
      suggestedRule: { tool: 'run_command', pattern: 'echo *' },
    });
    const answer = await kit.decide(kit.owner, approval!.id, { decision: 'allow', remember: 'session' });
    expect(answer.body.rule).toMatchObject({ scope: 'session', effect: 'allow', tool: 'run_command', pattern: 'echo *' });

    // The second echo is covered by the rule; `ls` is not, and is refused this time.
    const next = await until(async () => (await kit.pending(kit.owner, session.id)).find((entry) => entry.id !== approval!.id), { what: 'the approval for ls' });
    expect(next).toMatchObject({ command: 'ls src' });
    await kit.decide(kit.owner, next.id, { decision: 'deny' });
    finished(await kit.runEnded(kit.owner, message.body.runId!));

    expect(results(kit, 1)).toEqual(['Exit code 0.\n--- output ---\nhello world']);
    // Started directly: the quoting was read here, not by a shell.
    expect(results(kit, 2).at(-1)).toBe('Exit code 0.\n--- output ---\nhello   again');
    expect(results(kit, 3).at(-1)).toContain('Denied: The user denied this request.');
    const events = await kit.events(kit.owner, session.id);
    expect(eventsOf(events, 'approval.requested')).toHaveLength(2);
    expect(eventsOf(events, 'tool.finished').map((tool) => tool.status)).toEqual(['ok', 'ok', 'denied']);
    expect(eventsOf(events, 'tool.started')[0]).toMatchObject({ name: 'run_command', kind: 'execute', title: 'Run echo hello world', input: { command: 'echo hello world' } });
    // This test server has no sandbox: the transcript says so, once.
    expect(noticeCodes(events)).toEqual(['sandbox_unavailable']);
    expect(eventsOf(events, 'notice')[0].text).toContain('not confined to the project');
  });

  it('reports failures of a command as results, not as failures of the run', async () => {
    const session = await kit.session(provider);
    const rule = await kit.owner.post<PermissionRule>('/api/permission-rules', { scope: 'session', sessionId: session.id, effect: 'allow', tool: 'run_command' });
    expect(rule.status, JSON.stringify(rule.body)).toBe(201);
    kit.model.script(
      {
        toolCalls: [
          call('run_command', { command: 'false' }),
          call('run_command', { command: 'ls no-such-directory' }),
          call('run_command', { command: 'program-that-does-not-exist --version' }),
          call('run_command', { command: 'cat "unclosed' }),
          call('run_command', { command: 'printenv AGENT_STUDIO_DATA_DIR' }),
          call('run_command', { command: 'pwd' }),
        ],
      },
      { text: 'done' },
    );
    finished(await kit.turn(kit.owner, session.id, 'try things'));
    const [failed, missingDirectory, missingProgram, malformed, environment, cwd] = results();
    expect(failed).toBe('Exit code 1.\n(no output)');
    expect(missingDirectory).toMatch(/^Exit code [12]\.\n--- error output ---\nls: /);
    expect(missingProgram).toBe('There is no program "program-that-does-not-exist" on this server.');
    expect(malformed).toBe('Error: A double quote is not closed.');
    // The server's own settings are not in a command's environment.
    expect(environment).toBe('Exit code 1.\n(no output)');
    expect(cwd).toBe(`Exit code 0.\n--- output ---\n${kit.project.rootDir}`);
    expect(eventsOf(await kit.events(kit.owner, session.id), 'tool.finished').map((tool) => tool.status)).toEqual(['error', 'error', 'error', 'error', 'error', 'ok']);
  });

  it('without a sandbox, puts every shell line to a person — whatever the mode and the rules say', async () => {
    const project = await kit.makeProject('auto-mode');
    expect((await kit.owner.put(`/api/agents/projects/${project.id}/settings`, { autoMode: true })).status).toBe(200);
    const session = await kit.session(provider, kit.owner, { projectId: project.id, permissionMode: 'auto' });
    kit.model.script(
      { toolCalls: [call('run_command', { command: 'touch plain.txt' })] },
      { toolCalls: [call('run_command', { command: 'echo piped | tr a-z A-Z > shell.txt' })] },
      { toolCalls: [call('run_command', { command: "sh -c 'touch nested.txt'" })] },
      { toolCalls: [call('run_command', { command: 'echo one && echo two' })] },
      { text: 'done' },
    );
    const message = await kit.send(kit.owner, session.id, 'run them');

    // A plain command runs in auto mode without anybody being asked…
    const first = (await kit.pending(kit.owner, session.id))[0]!;
    expect(existsSync(path.join(project.rootDir, 'plain.txt'))).toBe(true);
    // …a line that needs a shell does not: it waits for a person, and cannot be remembered.
    expect(first).toMatchObject({ toolName: 'run_command', command: 'echo piped | tr a-z A-Z > shell.txt', suggestedRule: null });
    expect(first.reason).toContain('a person has to approve it each time');
    expect(existsSync(path.join(project.rootDir, 'shell.txt'))).toBe(false);
    const remembered = await kit.decide(kit.owner, first.id, { decision: 'allow', remember: 'session' });
    expect(remembered.status).toBe(422);
    expect((remembered.body as unknown as ErrorBody).error.code).toBe('remember_not_allowed');
    await kit.decide(kit.owner, first.id, { decision: 'allow' });

    // Starting a shell by name is the same thing.
    const second = await until(async () => (await kit.pending(kit.owner, session.id)).find((entry) => entry.id !== first.id), { what: 'the approval for sh -c' });
    expect(readFileSync(path.join(project.rootDir, 'shell.txt'), 'utf8')).toBe('PIPED\n');
    expect(second).toMatchObject({ command: "sh -c 'touch nested.txt'", suggestedRule: null });
    await kit.decide(kit.owner, second.id, { decision: 'deny' });

    // An allow rule for every command, saved meanwhile, does not answer a shell line either.
    const rule = await kit.owner.post<PermissionRule>('/api/permission-rules', { scope: 'account', effect: 'allow', tool: 'run_command' });
    expect(rule.status).toBe(201);
    const third = await until(async () => (await kit.pending(kit.owner, session.id)).find((entry) => entry.id !== first.id && entry.id !== second.id), { what: 'the approval for &&' });
    expect(third).toMatchObject({ command: 'echo one && echo two', suggestedRule: null });
    await kit.decide(kit.owner, third.id, { decision: 'allow' });
    finished(await kit.runEnded(kit.owner, message.body.runId!));

    expect(existsSync(path.join(project.rootDir, 'nested.txt'))).toBe(false);
    expect(results().at(-1)).toBe('Exit code 0.\n--- output ---\none\ntwo');
    const events = await kit.events(kit.owner, session.id);
    expect(eventsOf(events, 'approval.requested')).toHaveLength(3);
    expect(eventsOf(events, 'tool.finished').map((tool) => tool.status)).toEqual(['ok', 'ok', 'denied', 'ok']);
    expect(noticeCodes(events)).toEqual(['sandbox_unavailable']);

    // With the rule in place a plain command needs nobody in `ask` mode — and a shell line still does, and is denied where nobody watches.
    const asking = await kit.session(provider, kit.owner, { projectId: project.id });
    kit.model.reset();
    kit.model.script({ toolCalls: [call('run_command', { command: 'touch by-rule.txt' }), call('run_command', { command: 'touch a.txt; touch b.txt' })] }, { text: 'done' });
    const agents = kit.t.studio.context.services.agents;
    const receipt = await agents.sendMessage(agents.principalFor(kit.owner.userId!)!, asking.id, { requestId: nextRequestId(), text: 'unattended' }, { origin: 'automation' });
    await kit.runEnded(kit.owner, receipt.runId!);
    expect(existsSync(path.join(project.rootDir, 'by-rule.txt'))).toBe(true);
    expect(existsSync(path.join(project.rootDir, 'a.txt'))).toBe(false);
    expect(results().at(-1)).toContain('Denied: This needs approval, and nobody is watching');
    await kit.owner.delete(`/api/permission-rules/${rule.body.id}`);
  });

  it('asks about network access separately from the command itself', async () => {
    const session = await kit.session(provider);
    kit.model.script({ toolCalls: [call('run_command', { command: 'touch fetched-1.txt', network: true })] }, { toolCalls: [call('run_command', { command: 'touch fetched-2.txt', network: true })] }, { text: 'done' });
    const message = await kit.send(kit.owner, session.id, 'download things');

    const command = (await kit.pending(kit.owner, session.id))[0]!;
    expect(command).toMatchObject({ toolName: 'run_command', toolKind: 'execute', command: 'touch fetched-1.txt' });
    await kit.decide(kit.owner, command.id, { decision: 'allow' });
    const network = await until(async () => (await kit.pending(kit.owner, session.id)).find((entry) => entry.id !== command.id), { what: 'the network approval' });
    expect(network).toMatchObject({ toolName: 'run_command_network', toolKind: 'fetch', title: 'Give network access to: touch fetched-1.txt', command: 'touch fetched-1.txt', toolCallId: command.toolCallId });
    // Allowing the command was not allowing the network: nothing ran yet.
    expect(existsSync(kit.file('fetched-1.txt'))).toBe(false);
    await kit.decide(kit.owner, network.id, { decision: 'deny', note: 'no network today' });

    const again = await until(async () => (await kit.pending(kit.owner, session.id)).find((entry) => entry.id !== command.id && entry.id !== network.id), { what: 'the second command approval' });
    await kit.decide(kit.owner, again.id, { decision: 'allow' });
    const second = await until(async () => (await kit.pending(kit.owner, session.id)).find((entry) => entry.toolName === 'run_command_network' && entry.id !== network.id), { what: 'the second network approval' });
    await kit.decide(kit.owner, second.id, { decision: 'allow' });
    finished(await kit.runEnded(kit.owner, message.body.runId!));

    expect(existsSync(kit.file('fetched-1.txt'))).toBe(false);
    expect(existsSync(kit.file('fetched-2.txt'))).toBe(true);
    expect(results(kit, 1)[0]).toContain('Denied: no network today');
    expect(eventsOf(await kit.events(kit.owner, session.id), 'tool.finished').map((tool) => tool.status)).toEqual(['denied', 'ok']);
  });

  it('stops a command when its time is up, and when the run is stopped', async () => {
    const session = await kit.session(provider);
    await kit.owner.post('/api/permission-rules', { scope: 'session', sessionId: session.id, effect: 'allow', tool: 'run_command' });
    const processes = kit.t.studio.context.processes;
    kit.model.script({ toolCalls: [call('run_command', { command: 'sleep 20', timeout_seconds: 1 })] }, { text: 'It timed out.' });
    const started = Date.now();
    finished(await kit.turn(kit.owner, session.id, 'wait a while'));
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(results()[0]).toBe('The command was stopped after 1 s (timeout).\n(no output)');
    expect(processes.running).toBe(0);

    kit.model.script({ toolCalls: [call('run_command', { command: 'sleep 30' })] }, { text: 'never reached' });
    const message = await kit.send(kit.owner, session.id, 'wait for ever');
    await until(() => processes.running === 1, { what: 'the command to be running' });
    const stopping = Date.now();
    await kit.owner.post(`/api/sessions/${session.id}/stop`);
    const run = await kit.runEnded(kit.owner, message.body.runId!);
    expect(run.status).toBe('stopped');
    await until(() => processes.running === 0, { what: 'the command to be gone' });
    expect(Date.now() - stopping).toBeLessThan(15_000);
    // The model was not asked again after the stop.
    expect(kit.model.chats).toHaveLength(3);
    expect(kit.t.studio.context.services.providers.activeTurns).toBe(0);
  });
});

describe('paths that try to leave the project', () => {
  it('refuses them in every file tool, before anybody is asked and without touching anything', async () => {
    const outside = path.join(kit.t.workspace, 'outside.txt');
    writeFileSync(outside, 'TOP SECRET OUTSIDE\n');
    mkdirSync(kit.file('.git'));
    writeFileSync(kit.file('.git', 'config'), '[remote "origin"]\n\turl = https://token:GIT-INTERNAL-MARKER@example.com/repo.git\n');
    mkdirSync(kit.file('sub'));
    symlinkSync(kit.t.workspace, kit.file('link-out'));
    symlinkSync(outside, kit.file('link-file'));
    symlinkSync(path.join(kit.t.workspace, 'not-there-yet'), kit.file('link-dangling'));
    symlinkSync(kit.file('.git'), kit.file('link-git'));
    const masterKey = path.join(kit.t.dataDir, 'master.key');
    const session = await kit.session(provider, kit.owner, { permissionMode: 'accept-edits' });

    const readPaths = ['../outside.txt', 'sub/../../outside.txt', outside, '/etc/passwd', 'link-out/outside.txt', 'link-file', '.git/config', 'sub/../.git/config', '.GIT/config', 'link-git/config', masterKey, 'notes.txt\u0000.png'];
    const directories = ['..', '../..', kit.t.workspace, '/etc', 'link-out', '.git', 'link-git', kit.t.dataDir];
    const writePaths = ['../escape.txt', path.join(kit.t.workspace, 'escape.txt'), '/tmp/agent-studio-escape.txt', 'link-out/escape.txt', 'link-dangling', 'link-dangling/escape.txt', 'link-file', '.git/hooks/pre-commit', 'link-git/hooks/pre-commit', path.join(kit.t.dataDir, 'escape.txt')];
    const calls: FakeToolCall[] = [
      ...readPaths.map((target) => call('read_file', { path: target })),
      ...directories.map((target) => call('list_directory', { path: target })),
      ...directories.map((target) => call('find_files', { pattern: '*', path: target })),
      ...directories.map((target) => call('search_text', { query: 'SECRET', path: target })),
      ...['link-file', '.git/config', masterKey].map((target) => call('search_text', { query: 'a', path: target })),
      ...writePaths.map((target) => call('write_file', { path: target, content: 'pwned\n' })),
      ...['../outside.txt', 'link-file', '.git/config', 'link-out/outside.txt', masterKey].map((target) => call('edit_file', { path: target, old_string: 'T', new_string: 'X' })),
    ];
    kit.model.script({ toolCalls: calls }, { text: 'Everything was refused.' });
    const run = await kit.turn(kit.owner, session.id, 'break out');
    expect(run.status).toBe('completed');

    const answers = results();
    expect(answers).toHaveLength(calls.length);
    for (const [index, answer] of answers.entries()) {
      expect(answer.startsWith('Error: '), `${calls[index]!.name} ${JSON.stringify(calls[index]!.arguments)} → ${answer}`).toBe(true);
    }
    const everythingSent = JSON.stringify(kit.model.chats.map((chat) => chat.body));
    expect(everythingSent).not.toContain('TOP SECRET OUTSIDE');
    expect(everythingSent).not.toContain('GIT-INTERNAL-MARKER');
    expect(everythingSent).not.toContain(readFileSync(masterKey, 'utf8').trim());
    expect(everythingSent).not.toContain('root:');

    // Nothing was written, anywhere.
    expect(readFileSync(outside, 'utf8')).toBe('TOP SECRET OUTSIDE\n');
    expect(readFileSync(kit.file('.git', 'config'), 'utf8')).toContain('GIT-INTERNAL-MARKER');
    for (const escaped of [path.join(kit.t.workspace, 'escape.txt'), '/tmp/agent-studio-escape.txt', path.join(kit.t.workspace, 'not-there-yet'), kit.file('.git', 'hooks'), path.join(kit.t.dataDir, 'escape.txt')]) {
      expect(existsSync(escaped), escaped).toBe(false);
    }
    // Nobody was asked about any of it, and every call shows in the transcript as failed.
    const events = await kit.events(kit.owner, session.id);
    expect(types(events)).not.toContain('approval.requested');
    expect(eventsOf(events, 'tool.finished').every((tool) => tool.status === 'error')).toBe(true);
    expect(eventsOf(events, 'tool.started')).toHaveLength(calls.length);
  });

  it('does not walk through links or into .git when searching the whole project', async () => {
    const session = await kit.session(provider);
    kit.model.script(
      { toolCalls: [call('search_text', { query: 'TOP SECRET' }), call('search_text', { query: 'GIT-INTERNAL-MARKER' }), call('find_files', { pattern: 'outside.txt' }), call('find_files', { pattern: 'config' }), call('list_directory', {})] },
      { text: 'Nothing found.' },
    );
    finished(await kit.turn(kit.owner, session.id, 'search everything'));
    const [secret, marker, outside, config, listing] = results();
    expect(secret).toBe('Nothing matches "TOP SECRET".');
    expect(marker).toBe('Nothing matches "GIT-INTERNAL-MARKER".');
    expect(outside).toBe('No file matches "outside.txt".');
    expect(config).toBe('No file matches "config".');
    // A listing names links as links and does not follow them.
    expect(listing).toContain('link-out (link)');
    expect(listing).toContain('.git/');
  });
});

describe('what the model gets wrong', () => {
  it('answers malformed arguments, unknown tools and wrong types with an error result, and goes on', async () => {
    const session = await kit.session(provider);
    kit.model.script(
      {
        toolCalls: [
          call('read_file', '{"path": "notes.txt"'),
          call('read_file', '["notes.txt"]'),
          call('read_file', 'not json at all'),
          call('launch_missiles', { target: 'moon' }),
          call('read_file', { path: 42 }),
          call('read_file', {}),
          call('search_text', { query: 'x', max_results: 100000 }),
          call('', { path: 'notes.txt' }),
          call('read_file', '', 'call_empty'),
        ],
      },
      { toolCalls: [call('read_file', { path: 'notes.txt' })] },
      { text: 'Got it on the second try.' },
    );
    const run = await kit.turn(kit.owner, session.id, 'read the notes');
    expect(run.status).toBe('completed');
    const first = results(kit, 1);
    expect(first.slice(0, 3)).toEqual(Array(3).fill('Error: The arguments of this call are not a JSON object. Send the call again with valid JSON.'));
    expect(first[3]).toBe('Error: There is no tool named "launch_missiles".');
    expect(first[4]).toContain('Error: The arguments are not valid — path:');
    expect(first[5]).toContain('Error: The arguments are not valid — path:');
    expect(first[6]).toContain('Error: The arguments are not valid — max_results:');
    expect(first[7]).toBe('Error: There is no tool named "(no name)".');
    // No arguments at all is an empty object: the tool itself says what is missing.
    expect(first[8]).toContain('Error: The arguments are not valid — path:');
    expect(results().at(-1)).toContain('alpha\nbeta\ngamma');
    // What goes back to the provider is well-formed even where the model's call was not: providers check it.
    const echoed = sent(kit, 1).find((message) => message.role === 'assistant')!.tool_calls!;
    expect(echoed).toHaveLength(9);
    for (const entry of echoed) {
      expect(entry.function.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
      expect(() => JSON.parse(entry.function.arguments) as unknown).not.toThrow();
    }
    expect(echoed.map((entry) => entry.function.name)).toEqual(['read_file', 'read_file', 'read_file', 'launch_missiles', 'read_file', 'read_file', 'search_text', 'unknown_tool', 'read_file']);
    expect(echoed[0]!.function.arguments).toBe('{}');
    expect(echoed[4]!.function.arguments).toBe('{"path":42}');

    const events = await kit.events(kit.owner, session.id);
    const started = eventsOf(events, 'tool.started');
    expect(started).toHaveLength(10);
    // What could not be read is shown as it came.
    expect(started[0]).toMatchObject({ name: 'read_file', kind: 'read', input: { arguments: '{"path": "notes.txt"' } });
    expect(started[3]).toMatchObject({ name: 'launch_missiles', kind: 'other' });
    expect(eventsOf(events, 'tool.finished').map((tool) => tool.status)).toEqual([...Array(9).fill('error'), 'ok']);
    expect(eventsOf(events, 'message.assistant').at(-1).text).toBe('Got it on the second try.');
  });
});

describe('limits', () => {
  const withLimits = async (limits: Record<string, number>, work: (limited: ProvidersKit, own: Provider) => Promise<void>): Promise<void> => {
    const limited = await createProvidersKit({ providers: { limits } });
    try {
      writeFileSync(limited.file('notes.txt'), 'alpha\nbeta\ngamma\n');
      writeFileSync(limited.file('big.txt'), `START\n${'0123456789 '.repeat(400)}\nEND\n`);
      await work(limited, await limited.provider());
    } finally {
      await limited.close();
    }
  };

  it('ends the tool use of a turn after too many rounds, lets the model answer once more, and says so', async () => {
    await withLimits({ maxToolRounds: 2 }, async (limited, own) => {
      const session = await limited.session(own);
      // A model that never stops asking for tools.
      limited.model.fallback = { text: 'Looking further…', toolCalls: [call('list_directory', {})] };
      const run = await limited.turn(limited.owner, session.id, 'explore for ever');
      expect(run.status).toBe('completed');
      // Two rounds with tools, then one last request in which the model may only answer.
      expect(limited.model.chats).toHaveLength(3);
      expect(limited.model.chats.map((chat) => chat.body.tool_choice)).toEqual(['auto', 'auto', 'none']);
      expect(results(limited).at(-1)).toContain('[Agent Studio: the limit of 2 rounds of tool calls in one turn was reached. No more tools can be called in this turn.');
      const events = await limited.events(limited.owner, session.id);
      expect(eventsOf(events, 'tool.started')).toHaveLength(2);
      const notices = eventsOf(events, 'notice');
      expect(notices.map((notice) => notice.code)).toEqual(['tool_limit']);
      expect(notices[0]).toMatchObject({ level: 'warning' });
      expect(notices[0].text).toContain('the limit of 2 rounds of tool calls in one turn was reached');
      // The tool calls of the last answer were not carried out; its text is kept.
      expect(eventsOf(events, 'message.assistant')).toHaveLength(3);
      expect(types(events).at(-1)).toBe('run.finished');
    });
  });

  it('carries out no more tool calls than a turn may make', async () => {
    await withLimits({ maxToolCalls: 3 }, async (limited, own) => {
      const session = await limited.session(own);
      limited.model.script({ toolCalls: Array.from({ length: 5 }, () => call('read_file', { path: 'notes.txt' })) }, { text: 'I read it three times.' });
      const run = await limited.turn(limited.owner, session.id, 'read it five times');
      expect(run.status).toBe('completed');
      const answers = results(limited);
      expect(answers).toHaveLength(5);
      expect(answers.slice(0, 3).every((answer) => answer.includes('alpha\nbeta\ngamma'))).toBe(true);
      expect(answers[3]).toBe('Not run: the limit of 3 tool calls in one turn was reached.');
      expect(answers[4]).toContain('Not run: the limit of 3 tool calls in one turn was reached.');
      expect(limited.model.lastChat.body.tool_choice).toBe('none');
      const events = await limited.events(limited.owner, session.id);
      expect(eventsOf(events, 'tool.started')).toHaveLength(3);
      expect(noticeCodes(events)).toEqual(['tool_limit']);
      expect(eventsOf(events, 'message.assistant').at(-1).text).toBe('I read it three times.');
    });
  });

  it('cuts the middle out of a long result, and ends the turn when results add up to too much', async () => {
    await withLimits({ maxResultBytes: 400, maxTurnResultBytes: 1000 }, async (limited, own) => {
      const session = await limited.session(own);
      limited.model.script({ toolCalls: [call('read_file', { path: 'big.txt' }), call('read_file', { path: 'big.txt' }), call('read_file', { path: 'big.txt' }), call('read_file', { path: 'notes.txt' })] }, { text: 'That was a lot.' });
      const run = await limited.turn(limited.owner, session.id, 'read the big file');
      expect(run.status).toBe('completed');
      const answers = results(limited);
      for (const answer of answers.slice(0, 3)) {
        expect(Buffer.byteLength(answer)).toBeLessThanOrEqual(400 + 250);
        expect(answer).toContain('big.txt — lines 1–3 of 3.');
        expect(answer).toMatch(/\[… \d+ bytes left out by the Studio: the result was too long …\]/);
        expect(answer).toContain('END');
      }
      // Three results of 400 bytes are more than 1 000: the fourth call is not carried out.
      expect(answers[3]).toContain('Not run: the tool results of this turn add up to more than 1000 bytes.');
      const events = await limited.events(limited.owner, session.id);
      expect(noticeCodes(events)).toEqual(['tool_limit']);
      // The transcript keeps the whole output; only what goes back to the model is cut.
      expect(eventsOf(events, 'tool.finished')[0].output.length).toBeGreaterThan(4000);
    });
  });

  it('ends a turn that works for too long', async () => {
    await withLimits({ maxTurnMs: 400 }, async (limited, own) => {
      const session = await limited.session(own);
      limited.model.script({ text: 'This answer takes far too long to arrive, word by word.', chunks: 20, paceMs: 60 });
      const started = Date.now();
      const run = await limited.turn(limited.owner, session.id, 'take your time');
      expect(run.status).toBe('completed');
      expect(Date.now() - started).toBeLessThan(15_000);
      const events = await limited.events(limited.owner, session.id);
      expect(noticeCodes(events)).toEqual(['time_limit']);
      expect(eventsOf(events, 'notice')[0].text).toContain('the most one turn may take');
      // What had arrived is kept, marked as unfinished.
      const partial = eventsOf(events, 'message.assistant');
      expect(partial).toHaveLength(1);
      expect(partial[0].partial).toBe(true);
      await until(() => limited.model.openStreams === 0, { what: 'the stream to be closed' });
    });
  });

  it('does not count the time a person takes to answer an approval', async () => {
    await withLimits({ maxTurnMs: 2000 }, async (limited, own) => {
      const session = await limited.session(own);
      limited.model.script({ toolCalls: [call('write_file', { path: 'slow-approval.txt', content: 'worth the wait\n' })] }, { text: 'Written after a long wait.' });
      const message = await limited.send(limited.owner, session.id, 'write it');
      const [approval] = await limited.pending(limited.owner, session.id);
      // Longer than the whole turn may work for.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      await limited.decide(limited.owner, approval!.id, { decision: 'allow' });
      const run = await limited.runEnded(limited.owner, message.body.runId!);
      expect(run.status).toBe('completed');
      expect(existsSync(limited.file('slow-approval.txt'))).toBe(true);
      expect(noticeCodes(await limited.events(limited.owner, session.id))).toEqual([]);
    });
  });

  it('ends the turn when the tool results no longer fit the model\'s context window', async () => {
    await withLimits({}, async (limited) => {
      const cramped = await limited.provider({ models: [{ id: 'cramped', name: 'Cramped', contextWindow: 9_000, tools: true }] });
      const session = await limited.session(cramped);
      limited.model.fallback = { toolCalls: [call('read_file', { path: 'big.txt' })] };
      const run = await limited.turn(limited.owner, session.id, 'read the big file again and again');
      expect(run.status).toBe('completed');
      const events = await limited.events(limited.owner, session.id);
      expect(noticeCodes(events)).toEqual(['context_full']);
      expect(eventsOf(events, 'notice')[0].text).toContain('no longer fit into the context window of Cramped');
      // It stopped long before the limits on rounds and calls, after at least one tool had run.
      expect(eventsOf(events, 'tool.started').length).toBeGreaterThanOrEqual(1);
      expect(limited.model.chats.length).toBeLessThan(8);
    });
  });
});

describe("the Studio's own tools", () => {
  const notesIn = async (folder: string): Promise<string[]> => (await kit.owner.get<MemoryListResponse>(`/api/memory/notes?folder=${folder}`)).body.notes.map((entry) => entry.id);

  it('reaches shared memory with the scope of the session\'s project, asking before it writes', async () => {
    const other = await kit.makeProject('other-project');
    const session = await kit.session(provider);
    kit.model.script(
      { toolCalls: [call('memory_write', { title: 'Indentation rule', content: 'This project indents with tabs, never spaces.', scope: 'project', replace: false })] },
      { toolCalls: [call('memory_search', { query: 'indents tabs', scope: 'all', limit: 5 }), call('memory_write', { title: 'Refused note', content: 'This one is refused by the user.', replace: false })] },
      { text: 'Saved and found.' },
    );
    const message = await kit.send(kit.owner, session.id, 'remember that we indent with tabs');
    // Writing to memory changes something: it goes through the permission engine like any other change.
    const first = (await kit.pending(kit.owner, session.id))[0]!;
    expect(first).toMatchObject({ toolName: 'memory_write', toolKind: 'other', input: { title: 'Indentation rule' } });
    expect(await notesIn('demo')).not.toContain('demo/indentation-rule');
    await kit.decide(kit.owner, first.id, { decision: 'allow' });
    const second = await until(async () => (await kit.pending(kit.owner, session.id)).find((entry) => entry.id !== first.id), { what: 'the second memory approval' });
    await kit.decide(kit.owner, second.id, { decision: 'deny' });
    finished(await kit.runEnded(kit.owner, message.body.runId!));

    // The note landed in the folder of the session's project, signed with the agent's name.
    expect(await notesIn('demo')).toContain('demo/indentation-rule');
    expect(await notesIn('other-project')).toEqual([]);
    const saved = (await kit.owner.get<{ author: string }>('/api/memory/note?id=demo/indentation-rule')).body;
    expect(saved.author).toBe(provider.agentId);
    const [search, refused] = results().slice(-2);
    // Reading memory needs nobody's approval.
    expect(search).toContain('demo/indentation-rule');
    expect(refused).toContain('Denied:');
    expect(await notesIn('demo')).not.toContain('demo/refused-note');
    const events = await kit.events(kit.owner, session.id);
    expect(eventsOf(events, 'tool.started').map((tool) => [tool.name, tool.kind])).toEqual([['memory_write', 'other'], ['memory_search', 'read'], ['memory_write', 'other']]);
    expect(eventsOf(events, 'tool.finished').map((tool) => tool.status)).toEqual(['ok', 'ok', 'denied']);
    expect(eventsOf(events, 'approval.requested')).toHaveLength(2);
    // Each approval names the tool call it was asked for.
    const started = eventsOf(events, 'tool.started');
    expect([first.toolCallId, second.toolCallId]).toEqual([started[0].toolCallId, started[2].toolCallId]);

    // A conversation of another project cannot find or read that note, whatever it asks for.
    const elsewhere = await kit.session(provider, kit.owner, { projectId: other.id });
    kit.model.script({ toolCalls: [call('memory_search', { query: 'indents tabs', scope: 'all', limit: 5 }), call('memory_read', { id: 'demo/indentation-rule', offset: 0 }), call('memory_list', { scope: 'all', limit: 20 })] }, { text: 'Nothing there.' });
    finished(await kit.turn(kit.owner, elsewhere.id, 'how do we indent?'));
    const fromElsewhere = results().join('\n');
    expect(fromElsewhere).not.toContain('indents with tabs');
    expect(JSON.stringify(sent(kit))).not.toContain('never spaces');

    // And one outside any project reaches only what is global.
    const general = await kit.session(provider, kit.owner, { projectId: null });
    kit.model.script({ toolCalls: [call('memory_search', { query: 'indents tabs', scope: 'all', limit: 5 }), call('memory_read', { id: 'demo/indentation-rule', offset: 0 })] }, { text: 'Nothing there either.' });
    finished(await kit.turn(kit.owner, general.id, 'how do we indent?'));
    expect(JSON.stringify(sent(kit))).not.toContain('never spaces');
  });
});
