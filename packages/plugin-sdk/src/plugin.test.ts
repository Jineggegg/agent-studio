import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { HostError, PLUGIN_PROTOCOL_VERSION, createPluginRuntime } from './index.js';
import type { PluginDefinition } from './index.js';

type Message = Record<string, unknown>;

/** Plays the Studio: feeds lines to a runtime and collects what it writes back. */
function harness(definition: PluginDefinition, options: { maxMessageBytes?: number } = {}) {
  const input = new EventEmitter();
  const sent: Message[] = [];
  const warnings: string[] = [];
  const waiters: { match: (message: Message) => boolean; resolve: (message: Message) => void }[] = [];
  let exitCode: number | null = null;

  const runtime = createPluginRuntime(definition, {
    input,
    output: {
      write(text: string) {
        for (const line of text.split('\n').filter(Boolean)) {
          const message = JSON.parse(line) as Message;
          sent.push(message);
          const index = waiters.findIndex((waiter) => waiter.match(message));
          if (index !== -1) waiters.splice(index, 1)[0]!.resolve(message);
        }
      },
    },
    exit: (code) => {
      exitCode = code;
    },
    warn: (message) => warnings.push(message),
    ...options,
  });

  const next = (match: (message: Message) => boolean) =>
    new Promise<Message>((resolve) => {
      const seen = sent.find(match);
      if (seen) resolve(seen);
      else waiters.push({ match, resolve });
    });

  let id = 0;
  return {
    runtime,
    sent,
    warnings,
    get exitCode() {
      return exitCode;
    },
    raw: (text: string) => input.emit('data', Buffer.from(text)),
    end: () => input.emit('end'),
    /** Sends a request and resolves with the runtime's reply to it. */
    call(method: string, params: Message = {}) {
      id += 1;
      const requestId = `h${id}`;
      input.emit('data', JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      return next((message) => message.id === requestId && !('method' in message));
    },
    /** Waits for the plugin to ask the host for something. */
    hostRequest: (method: string) => next((message) => message.method === method && !answered.has(message)),
    answer(request: Message, result: unknown) {
      answered.add(request);
      input.emit('data', JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
    },
    refuse(request: Message, code: string, message: string) {
      answered.add(request);
      input.emit('data', JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message, data: { code } } }) + '\n');
    },
  };
}
const answered = new WeakSet<Message>();

const initialize = { protocol: PLUGIN_PROTOCOL_VERSION, scope: 's-init', plugin: { id: 'demo', version: '1.2.3' }, studio: { version: '2.0.0' }, permissions: ['notifications'] };
const alice = { id: 'u1', displayName: 'Alice' };

describe('plugin runtime', () => {
  it('answers initialize with what the plugin implements, after running onStart', async () => {
    const onStart = vi.fn();
    const h = harness({
      tools: { count: () => 'x', echo: () => 'y' },
      panelMethods: { summary: () => null },
      hooks: { 'run.finished': () => {} },
      onStart,
    });
    const reply = await h.call('initialize', initialize);
    expect(reply.result).toEqual({ protocol: 1, tools: ['count', 'echo'], panelMethods: ['summary'], hooks: ['run.finished'] });
    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart.mock.calls[0]![0]).toMatchObject({
      user: null,
      projectId: null,
      plugin: { id: 'demo', version: '1.2.3', studioVersion: '2.0.0', permissions: ['notifications'] },
    });
  });

  it('refuses a protocol version it does not speak', async () => {
    const h = harness({});
    const reply = await h.call('initialize', { ...initialize, protocol: 99 });
    expect(reply.error).toMatchObject({ data: { code: 'unsupported_protocol' } });
  });

  it('runs a tool with its input and the identity the Studio supplied', async () => {
    const h = harness({
      tools: {
        greet: (input, context) =>
          `Hello ${context.user.displayName} (${context.user.id}), ${String(input.word)} in ${context.projectId} run ${context.run.runId}/${context.run.sessionId}/${context.run.agentId} as ${context.tool}`,
      },
    });
    await h.call('initialize', initialize);
    const reply = await h.call('tool.call', {
      scope: 's1',
      tool: 'greet',
      input: { word: 'welcome' },
      context: { user: alice, projectId: 'p1', runId: 'r1', sessionId: 'c1', agentId: 'claude-code' },
    });
    expect(reply.result).toEqual({ text: 'Hello Alice (u1), welcome in p1 run r1/c1/claude-code as greet' });
  });

  it('normalises tool results and reports failures as errors, not crashes', async () => {
    const h = harness({
      tools: {
        object: () => ({ text: 'careful', isError: true }),
        other: () => ({ count: 3 }) as never,
        nothing: () => undefined as never,
        boom: () => {
          throw new Error('the handler broke');
        },
        refused: () => {
          throw new HostError('custom_code', 'no can do');
        },
      },
    });
    await h.call('initialize', initialize);
    const call = (tool: string) => h.call('tool.call', { scope: 's', tool, input: {}, context: { user: alice } });
    expect((await call('object')).result).toEqual({ text: 'careful', isError: true });
    expect((await call('other')).result).toEqual({ text: '{"count":3}' });
    expect((await call('nothing')).result).toEqual({ text: '' });
    expect((await call('boom')).error).toMatchObject({ code: -32000, message: 'the handler broke', data: { code: 'handler_failed' } });
    expect((await call('refused')).error).toMatchObject({ message: 'no can do', data: { code: 'custom_code' } });
    expect((await call('missing')).error).toMatchObject({ data: { code: 'unknown_tool' } });
    // Names inherited from Object.prototype are not tools.
    expect((await call('constructor')).error).toMatchObject({ data: { code: 'unknown_tool' } });
    expect((await call('toString')).error).toMatchObject({ data: { code: 'unknown_tool' } });
  });

  it('refuses a tool call or panel request that names no user', async () => {
    const h = harness({ tools: { t: () => 'x' }, panelMethods: { m: () => 1 } });
    await h.call('initialize', initialize);
    expect((await h.call('tool.call', { scope: 's', tool: 't', input: {}, context: {} })).error).toMatchObject({ data: { code: 'invalid_request' } });
    expect((await h.call('panel.request', { scope: 's', method: 'm', context: { user: { id: 7 } } })).error).toMatchObject({
      data: { code: 'invalid_request' },
    });
  });

  it('sends host requests tagged with the scope of the call they are made in', async () => {
    const h = harness({
      tools: {
        remember: async (input, { host }) => {
          const before = await host.storage.get<number>('count');
          await host.storage.set('count', (before ?? 0) + 1);
          const keys = await host.storage.list({ prefix: 'c' });
          const removed = await host.storage.delete('old');
          return `${before} ${keys.join(',')} ${removed}`;
        },
      },
    });
    await h.call('initialize', initialize);
    const pending = h.call('tool.call', { scope: 'scope-42', tool: 'remember', input: {}, context: { user: alice } });

    const get = await h.hostRequest('host.storage.get');
    expect(get).toMatchObject({ jsonrpc: '2.0', params: { scope: 'scope-42', key: 'count' } });
    h.answer(get, { found: true, value: 4 });
    const set = await h.hostRequest('host.storage.set');
    expect(set.params).toEqual({ scope: 'scope-42', key: 'count', value: 5 });
    h.answer(set, {});
    const list = await h.hostRequest('host.storage.list');
    expect(list.params).toEqual({ scope: 'scope-42', prefix: 'c' });
    h.answer(list, { keys: ['count'] });
    const remove = await h.hostRequest('host.storage.delete');
    h.answer(remove, { deleted: false });

    expect((await pending).result).toEqual({ text: '4 count false' });
  });

  it('turns a missing value into undefined and a refusal into a HostError with its code', async () => {
    const seen: unknown[] = [];
    const h = harness({
      panelMethods: {
        probe: async (_params, { host }) => {
          seen.push(await host.storage.get('nothing'));
          try {
            await host.notify({ title: 'hi' });
          } catch (error) {
            seen.push(error);
          }
          return null;
        },
      },
    });
    await h.call('initialize', initialize);
    const pending = h.call('panel.request', { scope: 's', panelId: 'main', method: 'probe', context: { user: alice, slot: 'home-tile' } });
    h.answer(await h.hostRequest('host.storage.get'), { found: false });
    const notify = await h.hostRequest('host.notify');
    expect(notify.params).toEqual({ scope: 's', title: 'hi', body: '' });
    h.refuse(notify, 'permission_denied', 'This plugin may not send notifications.');
    expect((await pending).result).toBeNull();
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBeInstanceOf(HostError);
    expect(seen[1]).toMatchObject({ code: 'permission_denied', message: 'This plugin may not send notifications.' });
  });

  it('passes every other capability through with its scope', async () => {
    const h = harness({
      panelMethods: {
        all: async (_params, { host }) => {
          const page = await host.http.fetch('https://api.example.com/x', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
          const projects = await host.projects.list();
          const file = await host.files.read('p1', 'README.md', { maxBytes: 100 });
          return { status: page.status, projects: projects.length, content: file.content };
        },
      },
    });
    await h.call('initialize', initialize);
    const pending = h.call('panel.request', { scope: 'sp', panelId: 'main', method: 'all', context: { user: alice, slot: 'project-tab', projectId: 'p1' } });
    const fetch = await h.hostRequest('host.http.fetch');
    expect(fetch.params).toEqual({ scope: 'sp', url: 'https://api.example.com/x', method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    h.answer(fetch, { status: 201, headers: {}, body: '', encoding: 'utf8' });
    const list = await h.hostRequest('host.projects.list');
    expect(list.params).toEqual({ scope: 'sp' });
    h.answer(list, { projects: [{ id: 'p1', name: 'One', access: 'read' }] });
    const read = await h.hostRequest('host.files.read');
    expect(read.params).toEqual({ scope: 'sp', projectId: 'p1', path: 'README.md', maxBytes: 100 });
    h.answer(read, { path: 'README.md', size: 5, truncated: false, encoding: 'utf8', content: 'hello' });
    expect((await pending).result).toEqual({ status: 201, projects: 1, content: 'hello' });
  });

  it('gives panel methods their parameters and context, and delivers hooks without a user', async () => {
    const hook = vi.fn();
    const h = harness({
      panelMethods: {
        summary: (params, context) => ({ params: params ?? null, user: context.user.displayName, panel: context.panel, project: context.projectId, method: context.method }),
        silent: () => {},
      },
      hooks: { 'run.finished': hook },
    });
    await h.call('initialize', initialize);
    const reply = await h.call('panel.request', {
      scope: 's',
      panelId: 'main',
      method: 'summary',
      params: { page: 2 },
      context: { user: alice, projectId: 'p9', slot: 'project-tab' },
    });
    expect(reply.result).toEqual({ params: { page: 2 }, user: 'Alice', panel: { panelId: 'main', slot: 'project-tab' }, project: 'p9', method: 'summary' });
    expect((await h.call('panel.request', { scope: 's', panelId: 'main', method: 'silent', context: { user: alice } })).result).toBeNull();
    expect((await h.call('panel.request', { scope: 's', panelId: 'main', method: 'nope', context: { user: alice } })).error).toMatchObject({
      data: { code: 'unknown_method' },
    });

    const payload = { runId: 'r', sessionId: 's', projectId: null, agentId: 'codex', status: 'completed' };
    expect((await h.call('hook.event', { scope: 'sh', event: 'run.finished', payload })).result).toBeNull();
    expect(hook).toHaveBeenCalledWith(payload, expect.objectContaining({ user: null, event: 'run.finished' }));
    // A hook the plugin does not implement is acknowledged and ignored.
    expect((await h.call('hook.event', { scope: 'sh', event: 'project.created', payload: { projectId: 'p' } })).result).toBeNull();
  });

  it('writes log lines as notifications that expect no answer', async () => {
    const h = harness({ tools: { noisy: (_input, { host }) => (host.log('working', 'warn'), host.log('x'.repeat(10_000)), 'done') } });
    await h.call('initialize', initialize);
    await h.call('tool.call', { scope: 's', tool: 'noisy', input: {}, context: { user: alice } });
    const logs = h.sent.filter((message) => message.method === 'host.log');
    expect(logs[0]).toEqual({ jsonrpc: '2.0', method: 'host.log', params: { level: 'warn', message: 'working' } });
    expect(logs[0]).not.toHaveProperty('id');
    expect((logs[1]!.params as { level: string; message: string }).level).toBe('info');
    expect((logs[1]!.params as { message: string }).message).toHaveLength(4000);
  });

  it('answers with an error when a result is too large for one message', async () => {
    const h = harness({ tools: { huge: () => 'x'.repeat(5000) } }, { maxMessageBytes: 1024 });
    await h.call('initialize', initialize);
    const reply = await h.call('tool.call', { scope: 's', tool: 'huge', input: {}, context: { user: alice } });
    expect(reply.error).toMatchObject({ data: { code: 'too_large' } });
  });

  it('rejects a host request that would be too large without sending it', async () => {
    let failure: unknown;
    const h = harness(
      {
        tools: {
          store: async (_input, { host }) => {
            try {
              await host.storage.set('k', 'x'.repeat(5000));
            } catch (error) {
              failure = error;
            }
            return 'ok';
          },
        },
      },
      { maxMessageBytes: 1024 },
    );
    await h.call('initialize', initialize);
    await h.call('tool.call', { scope: 's', tool: 'store', input: {}, context: { user: alice } });
    expect(failure).toMatchObject({ code: 'too_large' });
    expect(h.sent.some((message) => message.method === 'host.storage.set')).toBe(false);
  });

  it('ignores garbage, unknown notifications and answers nobody asked for', async () => {
    const h = harness({ tools: { ok: () => 'fine' } });
    await h.call('initialize', initialize);
    h.raw('this is not json\n[1,2]\n');
    h.raw(JSON.stringify({ jsonrpc: '2.0', method: 'some.notification' }) + '\n');
    h.raw(JSON.stringify({ jsonrpc: '2.0', id: 999, result: 'unasked' }) + '\n');
    h.raw(JSON.stringify({ jsonrpc: '2.0', id: { odd: true }, method: 'tool.call' }) + '\n');
    expect(h.warnings).toHaveLength(2);
    expect((await h.call('tool.call', { scope: 's', tool: 'ok', input: {}, context: { user: alice } })).result).toEqual({ text: 'fine' });
    expect((await h.call('not.a.method')).error).toMatchObject({ data: { code: 'unknown_method' } });
  });

  it('runs onStop, answers and exits on shutdown', async () => {
    const onStop = vi.fn();
    const h = harness({ onStop });
    await h.call('initialize', initialize);
    const reply = await h.call('shutdown', { scope: 's-stop' });
    expect(reply.result).toBeNull();
    expect(onStop).toHaveBeenCalledOnce();
    expect(await h.runtime.stopped).toBe(0);
    expect(h.exitCode).toBe(0);
  });

  it('exits when the Studio closes its end, failing whatever was still waiting', async () => {
    let failure: unknown;
    const h = harness({
      tools: {
        wait: async (_input, { host }) => {
          try {
            await host.storage.get('k');
          } catch (error) {
            failure = error;
          }
          return 'late';
        },
      },
    });
    await h.call('initialize', initialize);
    void h.call('tool.call', { scope: 's', tool: 'wait', input: {}, context: { user: alice } });
    await h.hostRequest('host.storage.get');
    const before = h.sent.length;
    h.end();
    expect(await h.runtime.stopped).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(failure).toMatchObject({ code: 'closed' });
    // Nothing more is written once the runtime has stopped.
    expect(h.sent.length).toBe(before);
  });

  it('refuses a definition that is not made of functions', () => {
    const io = { input: new EventEmitter(), output: { write: () => {} }, exit: () => {} };
    expect(() => createPluginRuntime({ tools: { broken: 'nope' as never } }, io)).toThrow(/tools\.broken must be a function/);
    expect(() => createPluginRuntime({ hooks: [] as never }, io)).toThrow(/"hooks" must be an object/);
    expect(() => createPluginRuntime({ onStart: 5 as never }, io)).toThrow(/onStart must be a function/);
    expect(() => createPluginRuntime(null as never, io)).toThrow(/needs an object/);
  });
});
