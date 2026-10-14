import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { PluginContributions, PluginPanelGrant } from '@agent-studio/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TestClient } from '../../src/testing/harness.js';
import { EXAMPLE_PLUGIN, HOSTILE_PLUGIN, SKIP_NO_BWRAP, bubblewrapWorks, eventually, manifest, pluginStudio, processesMentioning, serverCode, type PluginTestStudio } from './plugins-fixtures/kit.js';

/** A plugin that speaks just enough of the protocol to be started, and then ignores every request to leave. */
const STUBBORN = `import process from 'node:process';
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => {});
const answer = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
let rest = '';
process.stdin.on('data', (chunk) => {
  rest += chunk;
  const lines = rest.split('\\n');
  rest = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === 'initialize') answer(message.id, { protocol: 1, tools: [], panelMethods: ['ping'], hooks: [] });
    if (message.method === 'panel.request') answer(message.id, 'pong');
    // "shutdown" is not answered, and the end of input is not taken as a hint.
  }
});
setInterval(() => {}, 1000);
`;
const panelOnly = (id: string, extra: Record<string, unknown> = {}) =>
  manifest(id, { server: { entry: 'server.js' }, contributes: { panels: [{ id: 'main', title: 'P', entry: 'p/index.html', slots: ['home-tile'] }] }, ...extra });

describe('a plugin process that misbehaves', () => {
  let t: PluginTestStudio;
  let owner: TestClient;
  let grant: PluginPanelGrant;
  let rssAtStart: number;

  beforeAll(async () => {
    t = await pluginStudio({
      sources: { hostile: HOSTILE_PLUGIN },
      plugins: {
        limits: {
          panelCallTimeoutMs: 1500,
          // Failures are expected here, one after another: do not let the crash-loop guard end the series.
          maxCrashes: 1000,
          backoffBaseMs: 1,
          backoffMaxMs: 1,
          maxMessagesPerSecond: 200,
          maxQueuedBytes: 256 * 1024,
          memoryMb: 32,
          stopGraceMs: 500,
        },
      },
    });
    owner = await t.owner();
    await t.installAndEnable(owner, 'hostile', []);
    grant = await t.openPanel(owner, 'hostile', 'attack');
    rssAtStart = process.memoryUsage().rss;
  });
  afterAll(async () => {
    await t.close();
  });

  /** Runs an attack and waits until the Studio has dealt with the process. */
  const provoke = async (method: string, params?: Record<string, unknown>) => {
    const response = await t.rpcRaw(owner, grant, method, params);
    await eventually(() => t.studio.context.services.plugins.processId('hostile') === undefined, 5000, 'the process to be gone');
    const summary = await t.summary(owner, 'hostile');
    return { status: response.status, code: (response.body as unknown as { error?: { code: string } }).error?.code, summary };
  };
  const alive = async () => expect(await t.rpc(owner, grant, 'echo', { still: 'here' })).toMatchObject({ params: { still: 'here' } });

  it('is ended when it never answers and never lets go of the processor', async () => {
    const result = await provoke('hang');
    expect(result).toMatchObject({ status: 504, code: 'plugin_timeout', summary: { status: 'crashed', enabled: true } });
    expect(result.summary.statusDetail).toMatch(/did not answer "panel\.request" within 1500 ms.*started again when it is next needed/);
    // The next call starts a fresh process: one stuck call does not take the plugin down for good.
    await alive();
  });

  it('is ended when it never answers, quietly', async () => {
    const result = await provoke('silent');
    expect(result).toMatchObject({ status: 504, code: 'plugin_timeout', summary: { status: 'crashed' } });
    await alive();
  });

  it.each([
    ['unframed bytes', 'bytes', /sent a message larger than the limit/],
    ['garbage lines', 'garbage', /not protocol messages/],
    ['well-formed messages without end', 'valid', /flooded the Studio with messages/],
    ['one enormous message', 'big', /sent a message larger than the limit/],
  ])('is ended when it floods its output with %s', async (_what, mode, reason) => {
    const result = await provoke('flood', { mode });
    expect(result).toMatchObject({ status: 503, code: 'plugin_unavailable', summary: { status: 'crashed' } });
    expect(result.summary.statusDetail).toMatch(reason);
    await alive();
  });

  it('is ended when an answer is larger than a message may be', async () => {
    const result = await provoke('hugeAnswer');
    expect(result).toMatchObject({ status: 503, summary: { status: 'crashed' } });
    expect(result.summary.statusDetail).toMatch(/sent a message larger than the limit/);
    await alive();
  });

  it('dies at its memory cap without taking the server with it', async () => {
    const result = await provoke('memory');
    expect([503, 504]).toContain(result.status);
    expect(result.summary.status).toBe('crashed');
    expect(result.summary.logTail.join('\n')).toMatch(/heap out of memory|did not answer/);
    await alive();
  });

  it('is reported with its exit code when it dies in the middle of a call', async () => {
    const result = await provoke('crash');
    expect(result).toMatchObject({ status: 503, code: 'plugin_unavailable', summary: { status: 'crashed' } });
    expect(result.summary.statusDetail).toMatch(/exited with code 3/);
    await alive();
  });

  it('is ended when it stops reading, rather than letting what is sent to it pile up', async () => {
    expect(await t.rpc(owner, grant, 'stopReading')).toEqual({ paused: true });
    const blob = 'q'.repeat(100 * 1024);
    const responses = await Promise.all(Array.from({ length: 8 }, () => t.rpcRaw(owner, grant, 'echo', { blob })));
    expect(responses.every((response) => response.status === 503 || response.status === 504)).toBe(true);
    await eventually(() => t.studio.context.services.plugins.processId('hostile') === undefined);
    expect((await t.summary(owner, 'hostile')).statusDetail).toMatch(/is not reading what the Studio sends it/);
    await alive();
  });

  it('has only the tail of what it prints kept, with secrets removed', async () => {
    expect(await t.rpc(owner, grant, 'floodStderr')).toEqual({ wrote: 20000 });
    await eventually(async () => (await t.summary(owner, 'hostile')).logTail.join('\n').includes('AWS key'));
    const { logTail, status } = await t.summary(owner, 'hostile');
    expect(status).toBe('running');
    expect(logTail.join('\n').length).toBeLessThanOrEqual(17 * 1024);
    expect(logTail.at(-1)).toBe('AWS key [redacted] and token [redacted]');
    expect(logTail.join('\n')).not.toMatch(/AKIAABCDEFGHIJKLMNOP|ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
  });

  it('left the server healthy and nothing running behind', async () => {
    expect((await owner.get('/api/health')).body).toEqual({ status: 'ok' });
    // Megabytes were thrown at the server above; it kept none of them.
    expect(process.memoryUsage().rss - rssAtStart).toBeLessThan(200 * 1024 * 1024);
    await owner.post('/api/plugins/hostile/disable');
    await eventually(async () => (await processesMentioning(t.dataDir)).length === 0, 5000, 'no plugin process to be left');
    expect((await t.summary(owner, 'hostile')).status).toBe('stopped');
  });
});

describe('a plugin that keeps failing', () => {
  let t: PluginTestStudio;
  afterEach(async () => {
    await t?.close();
  });

  it('is started again with growing pauses, and disabled — with the reason — after repeated failures', async () => {
    t = await pluginStudio({
      sources: { hostile: HOSTILE_PLUGIN },
      plugins: { limits: { maxCrashes: 3, backoffBaseMs: 150, backoffMaxMs: 400, crashWindowMs: 60_000 } },
    });
    const owner = await t.owner();
    await t.installAndEnable(owner, 'hostile', []);
    const grant = await t.openPanel(owner, 'hostile', 'attack');
    const call = async () => {
      const response = await t.rpcRaw(owner, grant, 'echo');
      return { status: response.status, error: (response.body as unknown as { error?: { code: string; message: string } }).error };
    };
    expect((await call()).status).toBe(200);
    await owner.post('/api/plugins/hostile/disable');
    await t.enable(owner, 'hostile', []);
    const fresh = await t.openPanel(owner, 'hostile', 'attack');
    grant.panel = fresh.panel;

    // From now on it exits as soon as it is started.
    await mkdir(path.join(t.pluginDataDir, 'hostile'), { recursive: true });
    await writeFile(path.join(t.pluginDataDir, 'hostile', 'crash-on-start'), '');

    const first = await call();
    expect(first).toMatchObject({ status: 503, error: { code: 'plugin_unavailable' } });
    expect(first.error!.message).toMatch(/exited with code 7/);
    const afterFirst = await t.summary(owner, 'hostile');
    expect(afterFirst).toMatchObject({ enabled: true, status: 'crashed' });
    expect(afterFirst.statusDetail).toMatch(/The plugin process exited with code 7\. It will be started again when it is next needed\./);

    // Not at once: a failing plugin is not restarted in a tight loop.
    const tooSoon = await call();
    expect(tooSoon).toMatchObject({ status: 503, error: { code: 'plugin_backoff' } });
    expect(tooSoon.error!.message).toMatch(/tried again in \d+ s/);
    expect(t.studio.context.services.plugins.processId('hostile')).toBeUndefined();

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await call()).error).toMatchObject({ code: 'plugin_unavailable' });
    expect((await t.summary(owner, 'hostile')).enabled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect((await call()).status).toBe(503);

    // Third failure: out of service.
    const disabled = await t.summary(owner, 'hostile');
    expect(disabled).toMatchObject({ enabled: false, status: 'crashed', approval: { state: 'current' } });
    expect(disabled.statusDetail).toBe('Disabled after failing repeatedly. It failed 3 times within 1 minutes; the last time: The plugin process exited with code 7.');
    expect(disabled.logTail).toContain('[studio] disabled after repeated failures');
    expect(t.studio.context.agentTools.get('plugin_hostile_sneaky_read')).toBeUndefined();
    expect((await owner.get<PluginContributions>('/api/plugins/contributions')).body.homeTiles).toEqual([]);
    expect((await call()).status).toBe(410);
    expect((await owner.post('/api/plugins/hostile/panels/attack/open', { slot: 'home-tile' })).status).toBe(404);
    const events = (await owner.get<{ events: { action: string; subject: string; detail: string; userId: string | null }[] }>('/api/audit?limit=50')).body.events;
    expect(events.find((event) => event.action === 'plugin.auto-disabled')).toMatchObject({ subject: 'hostile', userId: null, detail: expect.stringContaining('exited with code 7') });
    expect(await processesMentioning(t.dataDir)).toEqual([]);

    // The reason survives a look at the database alone (as after a restart)…
    expect(t.studio.context.db.get<{ last_failure: string }>('SELECT last_failure FROM plugins WHERE id = ?', 'hostile')!.last_failure).toMatch(/exited with code 7/);
    // …and once the cause is fixed, the owner can turn it back on.
    await rm(path.join(t.pluginDataDir, 'hostile', 'crash-on-start'));
    expect(await t.enable(owner, 'hostile', [])).toMatchObject({ enabled: true, status: 'stopped', statusDetail: null });
    expect(await t.rpc(owner, await t.openPanel(owner, 'hostile', 'attack'), 'echo', { back: true })).toMatchObject({ params: { back: true } });
  });

  it('is ended when it does not complete the start-up handshake, or cannot be loaded at all', async () => {
    t = await pluginStudio({ plugins: { limits: { handshakeTimeoutMs: 500, backoffBaseMs: 1, backoffMaxMs: 1 } } });
    const owner = await t.owner();
    await t.writeSource('mute', { manifest: panelOnly('mute'), files: { 'server.js': 'setInterval(() => {}, 1000);\n', 'p/index.html': '<!doctype html>' } });
    await t.writeSource('broken', { manifest: panelOnly('broken'), files: { 'server.js': 'this is not ( javascript\n', 'p/index.html': '<!doctype html>' } });
    await t.writeSource('lost', {
      manifest: panelOnly('lost'),
      files: { 'server.js': "import { nothing } from './missing-module.js';\nnothing();\n", 'p/index.html': '<!doctype html>' },
    });
    await t.writeSource('liar', {
      manifest: panelOnly('liar'),
      files: {
        'p/index.html': '<!doctype html>',
        // Answers the handshake with an error of its own.
        'server.js': serverCode("definePlugin({ onStart: () => { throw new Error('I refuse to start'); } });"),
      },
    });
    for (const id of ['mute', 'broken', 'lost', 'liar']) await t.installAndEnable(owner, id);

    const mute = await t.rpcRaw(owner, await t.openPanel(owner, 'mute', 'main'), 'anything');
    expect(mute.status).toBe(504);
    expect((await t.summary(owner, 'mute')).statusDetail).toMatch(/did not complete the start-up handshake in time/);

    const broken = await t.rpcRaw(owner, await t.openPanel(owner, 'broken', 'main'), 'anything');
    expect(broken.status).toBe(503);
    const brokenSummary = await t.summary(owner, 'broken');
    expect(brokenSummary.status).toBe('crashed');
    expect(brokenSummary.logTail.join('\n')).toMatch(/SyntaxError/);

    expect((await t.rpcRaw(owner, await t.openPanel(owner, 'lost', 'main'), 'anything')).status).toBe(503);
    expect((await t.summary(owner, 'lost')).logTail.join('\n')).toMatch(/missing-module/);

    const liar = await t.rpcRaw(owner, await t.openPanel(owner, 'liar', 'main'), 'anything');
    expect(liar.status).toBe(503);
    expect((await t.summary(owner, 'liar')).statusDetail).toMatch(/failed to start: I refuse to start/);
    await eventually(async () => (await processesMentioning(t.dataDir)).length === 0, 5000, 'no plugin process to be left');
  });
});

describe('what a plugin says while failing', () => {
  let t: PluginTestStudio;
  afterEach(async () => {
    await t?.close();
  });

  it('is redacted before it is kept or returned: its start-up error, and a private key written over several chunks', async () => {
    t = await pluginStudio({ plugins: { limits: { backoffBaseMs: 1, backoffMaxMs: 1 } } });
    const owner = await t.owner();
    const token = 'ghp_ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7';
    const key = ['-----BEGIN PRIVATE KEY-----', 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw', 'ggSjAgEAAoIBAQC7XqLwPpVb4Kd2Hs9Yt1R', '-----END PRIVATE KEY-----'];
    await t.writeSource('leaky', {
      manifest: panelOnly('leaky'),
      files: {
        'p/index.html': '<!doctype html>',
        // The key arrives in two writes, a moment apart; then the handshake is answered with an error that quotes a token.
        'server.js': serverCode(`process.stderr.write(${JSON.stringify(`${key.slice(0, 2).join('\n')}\n`)});
const pause = () => new Promise((resolve) => setTimeout(resolve, 150));
definePlugin({
  onStart: async () => {
    await pause();
    process.stderr.write(${JSON.stringify(`${key.slice(2).join('\n')}\nafter the key\n`)});
    await pause();
    throw new Error('I refuse to start; my token is ${token}');
  },
});`),
      },
    });
    await t.installAndEnable(owner, 'leaky');

    const response = await t.rpcRaw(owner, await t.openPanel(owner, 'leaky', 'main'), 'anything');
    expect(response.status).toBe(503);
    const answered = JSON.stringify(response.body);
    expect(answered).toContain('I refuse to start; my token is [redacted]');
    expect(answered).not.toContain('ZQ7');

    await eventually(async () => (await t.summary(owner, 'leaky')).logTail.join('\n').includes('after the key'), 5000, 'the log to arrive');
    const summary = await t.summary(owner, 'leaky');
    expect(summary.statusDetail).toMatch(/failed to start: I refuse to start; my token is \[redacted\]/);
    const kept = JSON.stringify(summary);
    expect(kept).not.toContain('ZQ7');
    expect(kept).not.toMatch(/MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw|ggSjAgEAAoIBAQC7XqLwPpVb4Kd2Hs9Yt1R|BEGIN PRIVATE KEY/);
    expect(summary.logTail).toContain('[redacted]');
  });
});

describe('stopping', () => {
  let t: PluginTestStudio;
  afterEach(async () => {
    await t?.close();
  });
  const running = () => processesMentioning(t.dataDir);

  it('leaves no process behind when a plugin is disabled or the server shuts down', async () => {
    t = await pluginStudio({ sources: { 'notes-counter': EXAMPLE_PLUGIN } });
    await t.listen(); // a started server: modules get to stop their own work on shutdown
    const owner = await t.owner();
    await t.installAndEnable(owner, 'notes-counter');
    expect(await running()).toEqual([]);

    // Lazily: nothing ran until something was asked of it.
    await t.callTool(owner.userId!, 'plugin_notes_counter_count_notes', {});
    const before = await running();
    expect(before.length).toBeGreaterThanOrEqual(1);
    expect(t.studio.context.services.plugins.processId('notes-counter')).toBeGreaterThan(0);
    expect((await t.summary(owner, 'notes-counter')).status).toBe('running');

    await owner.post('/api/plugins/notes-counter/disable');
    expect(await running()).toEqual([]);
    expect((await t.summary(owner, 'notes-counter')).logTail.at(-1)).toBe('[studio] stopped');

    await t.enable(owner, 'notes-counter');
    await t.callTool(owner.userId!, 'plugin_notes_counter_count_notes', {});
    expect((await running()).length).toBeGreaterThanOrEqual(1);
    const dataDir = t.dataDir;
    await t.close();
    expect(await processesMentioning(dataDir)).toEqual([]);
    t = undefined as never;
  });

  it('leaves no process behind even when the server is closed without having been started', async () => {
    t = await pluginStudio({ sources: { 'notes-counter': EXAMPLE_PLUGIN } });
    const owner = await t.owner();
    await t.installAndEnable(owner, 'notes-counter');
    await t.callTool(owner.userId!, 'plugin_notes_counter_count_notes', {});
    expect((await running()).length).toBeGreaterThanOrEqual(1);
    const dataDir = t.dataDir;
    await t.close();
    expect(await processesMentioning(dataDir)).toEqual([]);
    t = undefined as never;
  });

  it.each([['auto'], ['off']] as const)('ends a plugin that ignores every request to leave (sandbox: %s)', async (sandbox) => {
    t = await pluginStudio({ config: { sandbox }, plugins: { limits: { stopGraceMs: 300 } } });
    const owner = await t.owner();
    await t.writeSource('stubborn', { manifest: panelOnly('stubborn'), files: { 'server.js': STUBBORN, 'p/index.html': '<!doctype html>' } });
    await t.installAndEnable(owner, 'stubborn');
    expect(await t.rpc(owner, await t.openPanel(owner, 'stubborn', 'main'), 'ping')).toBe('pong');
    expect((await running()).length).toBeGreaterThanOrEqual(1);

    const started = Date.now();
    expect((await owner.post('/api/plugins/stubborn/disable')).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await running()).toEqual([]);
    // Being slow to leave when asked is not counted against it as a crash.
    expect(await t.summary(owner, 'stubborn')).toMatchObject({ enabled: false, status: 'stopped' });
  });

  it('stops a plugin nobody has called for a while, and starts it again when it is needed', async () => {
    t = await pluginStudio({ sources: { 'notes-counter': EXAMPLE_PLUGIN }, plugins: { limits: { idleStopMs: 300 } } });
    const owner = await t.owner();
    await t.installAndEnable(owner, 'notes-counter');
    expect((await t.callTool(owner.userId!, 'plugin_notes_counter_add_note', { text: 'before the nap' })).text).toBe('Saved note #1.');
    expect((await running()).length).toBeGreaterThanOrEqual(1);
    await eventually(async () => (await running()).length === 0, 5000, 'the idle process to be stopped');
    expect(await t.summary(owner, 'notes-counter')).toMatchObject({ enabled: true, status: 'stopped', statusDetail: null });

    expect((await t.callTool(owner.userId!, 'plugin_notes_counter_count_notes', {})).text).toContain('before the nap');
    const log = (await t.summary(owner, 'notes-counter')).logTail;
    expect(log.filter((line) => line.startsWith('[studio] started'))).toHaveLength(2);
    expect(log).toContain('[studio] stopped');
  });
});

describe('what a running plugin may consume', () => {
  let t: PluginTestStudio;
  afterEach(async () => {
    await t?.close();
  });
  const HOG = serverCode(`
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
definePlugin({
  panelMethods: {
    // Memory outside the JavaScript heap, which the heap cap does not see.
    hoard: (params) => { globalThis.kept = Buffer.alloc(params.megabytes * 1024 * 1024, 1); return { held: globalThis.kept.length }; },
    // Busy long after the call that started it has returned.
    spinLater: () => { setTimeout(() => { for (;;) {} }, 100); return 'spinning soon'; },
    fill: (params) => { fs.writeFileSync('filler.bin', Buffer.alloc(params.megabytes * 1024 * 1024, 7)); return 'written'; },
    ping: () => 'pong',
  },
});
`);
  const setUp = async (limits: Record<string, number>) => {
    t = await pluginStudio({ plugins: { limits: { watchdogIntervalMs: 150, backoffBaseMs: 1, backoffMaxMs: 1, ...limits } } });
    const owner = await t.owner();
    await t.writeSource('hog', { manifest: panelOnly('hog'), files: { 'server.js': HOG, 'p/index.html': '<!doctype html>' } });
    await t.installAndEnable(owner, 'hog');
    const grant = await t.openPanel(owner, 'hog', 'main');
    const crashed = async (reason: RegExp) => {
      await eventually(async () => (await t.summary(owner, 'hog')).status === 'crashed', 8000, 'the watchdog to act');
      expect((await t.summary(owner, 'hog')).statusDetail).toMatch(reason);
      expect(await t.rpc(owner, grant, 'ping')).toBe('pong');
    };
    return { owner, grant, crashed };
  };

  it('is ended when it takes more memory than allowed', async (context) => {
    if (process.platform !== 'linux') return context.skip('Memory is measured through /proc, which only Linux has.');
    const { owner, grant, crashed } = await setUp({ maxRssBytes: 160 * 1024 * 1024 });
    expect(await t.rpc(owner, grant, 'hoard', { megabytes: 8 })).toEqual({ held: 8 * 1024 * 1024 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect((await t.summary(owner, 'hog')).status).toBe('running');
    // The watchdog may act while the allocation is still in progress, in which case the
    // call is answered with "the plugin stopped"; either way the plugin must end up stopped.
    await t.rpc(owner, grant, 'hoard', { megabytes: 220 }).then(
      (answer) => expect(answer).toEqual({ held: 220 * 1024 * 1024 }),
      (error: Error) => expect(error.message).toMatch(/used more memory than allowed/),
    );
    await crashed(/used more memory than allowed \(\d+ MiB\)/);
  });

  it('is ended when it keeps a processor busy while nothing has called it', async (context) => {
    if (process.platform !== 'linux') return context.skip('Processor time is measured through /proc, which only Linux has.');
    const { owner, grant, crashed } = await setUp({});
    expect(await t.rpc(owner, grant, 'spinLater')).toBe('spinning soon');
    await crashed(/kept the processor busy while nothing had called it/);
  });

  it('is ended when it fills its data folder beyond the limit', async () => {
    const { owner, grant, crashed } = await setUp({ maxDataBytes: 512 * 1024 });
    expect(await t.rpc(owner, grant, 'fill', { megabytes: 2 })).toBe('written');
    expect(existsSync(path.join(t.pluginDataDir, 'hog', 'filler.bin'))).toBe(true);
    await crashed(/filled its data folder beyond the limit/);
  });
});

describe('the unrestricted network permission', () => {
  let t: PluginTestStudio;
  afterEach(async () => {
    await t?.close();
  });
  const DIALLER = serverCode(`
import net from 'node:net';
definePlugin({
  panelMethods: {
    dial: (params) => new Promise((resolve) => {
      const socket = net.connect(params.port, '127.0.0.1');
      socket.setTimeout(1500, () => { socket.destroy(); resolve('timed out'); });
      socket.on('error', (error) => resolve('refused: ' + error.code));
      socket.on('connect', () => { socket.end(); resolve('connected'); });
    }),
  },
});
`);

  it('is what gives a plugin process real sockets — and nothing else does', async (context) => {
    if (!(await bubblewrapWorks())) return context.skip(SKIP_NO_BWRAP);
    t = await pluginStudio();
    const owner = await t.owner();
    let connections = 0;
    const server = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as net.AddressInfo;
    try {
      await t.writeSource('dialler', { manifest: panelOnly('dialler', { permissions: ['network', 'network:api.example.com'] }), files: { 'server.js': DIALLER, 'p/index.html': '<!doctype html>' } });
      await t.install(owner, 'dialler');

      // Asked for, but not granted: no network.
      await t.enable(owner, 'dialler', []);
      expect(await t.rpc(owner, await t.openPanel(owner, 'dialler', 'main'), 'dial', { port })).toMatch(/^refused/);
      // A host name to fetch from through the Studio is not a socket either.
      await owner.post('/api/plugins/dialler/disable');
      await t.enable(owner, 'dialler', ['network:api.example.com']);
      expect(await t.rpc(owner, await t.openPanel(owner, 'dialler', 'main'), 'dial', { port })).toMatch(/^refused/);
      expect(connections).toBe(0);

      // Granted explicitly: the process shares the machine's network, loopback included.
      await owner.post('/api/plugins/dialler/disable');
      const granted = await t.enable(owner, 'dialler', ['network']);
      expect(granted.permissions.granted).toEqual(['network']);
      expect(await t.rpc(owner, await t.openPanel(owner, 'dialler', 'main'), 'dial', { port })).toBe('connected');
      await eventually(() => connections === 1);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
