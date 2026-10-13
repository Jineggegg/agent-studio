import { createHash } from 'node:crypto';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { PluginIsolation, PluginPanelGrant, Project } from '@agent-studio/protocol';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestClient } from '../../src/testing/harness.js';
import { EXAMPLE_PLUGIN, HOSTILE_PLUGIN, SKIP_NO_BWRAP, bubblewrapWorks, pluginStudio, type PluginTestStudio } from './plugins-fixtures/kit.js';

/**
 * A plugin written to break out, run under the isolation a real installation
 * with bubblewrap has. Every attempt it makes is asserted on its own.
 *
 * The same plugin is then run without bubblewrap, to pin down — as a test, so
 * that it cannot drift from the documentation — what Node's permission model
 * alone does and does not hold back.
 */

type Attempt = { ok: boolean; value?: unknown; code?: string | null; message?: string };
type Report = Record<string, Attempt>;

/** Values planted in the server's environment. None may ever show up inside a plugin. */
const PLANTED = {
  AGENT_STUDIO_MASTER_KEY_FAKE: 'planted-studio-setting-4f1c',
  AGENT_STUDIO_SESSION_SECRET_FAKE: 'planted-studio-secret-9a2e',
  OPENAI_API_KEY: 'sk-planted-openai-key-000000000000',
  ANTHROPIC_API_KEY: 'sk-ant-planted-anthropic-key-0000',
  GITHUB_TOKEN: 'ghp_plantedgithubtoken0000000000000000',
  AWS_SECRET_ACCESS_KEY: 'planted-aws-secret-key-7b3d',
  DATABASE_URL: 'postgres://user:planted-db-password@db.internal/prod',
  // An operator may let agents and terminals inherit a variable. Plugins are neither.
  PASSTHROUGH_TOKEN: 'planted-passthrough-token-51aa',
  SSH_AUTH_SOCK: '/run/user/1000/planted-agent.sock',
  HTTPS_PROXY: 'http://proxyuser:planted-proxy-password@proxy.internal:3128',
  NODE_OPTIONS_FAKE: 'planted-node-options',
};

interface Scene {
  t: PluginTestStudio;
  owner: TestClient;
  grant: PluginPanelGrant;
  isolation: PluginIsolation;
  /** A folder in the real home directory with a file no plugin should ever read. */
  homeSentinel: string;
  /** Counts every connection anything makes to this machine's loopback on a port only the test knows. */
  tcp: { server: net.Server; port: number; connections: number };
  /** The same port, for datagrams. */
  udp: { socket: dgram.Socket; datagrams: number };
  unix: { server: net.Server; file: string; connections: number };
  attack<T = Report>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): Promise<void>;
}

const savedEnv: Record<string, string | undefined> = {};

async function scene(sandbox: 'auto' | 'off', granted: string[]): Promise<Scene> {
  for (const [name, value] of Object.entries(PLANTED)) {
    savedEnv[name] = process.env[name];
    process.env[name] = value;
  }
  const t = await pluginStudio({
    sources: { hostile: HOSTILE_PLUGIN, 'notes-counter': EXAMPLE_PLUGIN },
    config: { sandbox, childEnvPassthrough: ['PASSTHROUGH_TOKEN', 'SSH_AUTH_SOCK'] },
  });
  const restoreEnv = () => {
    for (const name of Object.keys(PLANTED)) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
  };
  let owner: TestClient;
  let isolation: PluginIsolation;
  try {
    owner = await t.owner();
    await t.installAndEnable(owner, 'hostile', granted);
    isolation = await t.isolation(owner);
  } catch (error) {
    await t.close();
    restoreEnv();
    throw error;
  }

  const homeSentinel = await mkdtemp(path.join(os.homedir(), '.studio-plugin-hostile-test-'));
  await writeFile(path.join(homeSentinel, 'secret.txt'), 'a file in the real home directory');

  const tcp = { server: net.createServer(), port: 0, connections: 0 };
  tcp.server.on('connection', (socket) => {
    tcp.connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => tcp.server.listen(0, '127.0.0.1', resolve));
  tcp.port = (tcp.server.address() as net.AddressInfo).port;

  const udp = { socket: dgram.createSocket('udp4'), datagrams: 0 };
  udp.socket.on('message', () => {
    udp.datagrams += 1;
  });
  await new Promise<void>((resolve) => udp.socket.bind(tcp.port, '127.0.0.1', resolve));

  const unix = { server: net.createServer(), file: path.join(t.workspace, 'local-service.sock'), connections: 0 };
  unix.server.on('connection', (socket) => {
    unix.connections += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => unix.server.listen(unix.file, resolve));

  const grant = await t.openPanel(owner, 'hostile', 'attack');
  return {
    t,
    owner,
    grant,
    isolation,
    homeSentinel,
    tcp,
    udp,
    unix,
    attack: <T>(method: string, params: Record<string, unknown> = {}) => t.rpc<T>(owner, grant, method, params),
    async close() {
      await new Promise((resolve) => tcp.server.close(resolve));
      await new Promise<void>((resolve) => udp.socket.close(() => resolve()));
      await new Promise((resolve) => unix.server.close(resolve));
      await rm(homeSentinel, { recursive: true, force: true });
      await t.close();
      restoreEnv();
    },
  };
}

const failed = (report: Report, names: string[] = Object.keys(report)) =>
  Object.fromEntries(names.map((name) => [name, report[name]?.ok === false ? 'refused' : `GOT THROUGH: ${JSON.stringify(report[name])}`]));
const allRefused = (names: string[]) => Object.fromEntries(names.map((name) => [name, 'refused']));
const sha = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');

describe('a hostile plugin, sandboxed', () => {
  let s: Scene;
  let skipped = false;
  beforeAll(async () => {
    if (!(await bubblewrapWorks())) {
      skipped = true;
      console.warn(SKIP_NO_BWRAP);
      return;
    }
    // Granted: two host names for the Studio to fetch from. Requested but NOT granted: notifications, projects:read.
    s = await scene('auto', ['network:allowed.example.com', 'network:rebind.example.com']);
  });
  afterAll(async () => {
    await s?.close();
  });
  const sandboxed = (name: string, body: () => Promise<void>) =>
    it(name, async (context) => {
      if (skipped) return context.skip(SKIP_NO_BWRAP);
      await body();
    });

  sandboxed('runs under both layers, and the Studio says so', async () => {
    expect(s.isolation).toMatchObject({
      level: 'sandboxed',
      bubblewrap: true,
      nodePermissions: true,
      restricts: { files: true, processes: true, network: true, otherProcesses: true },
    });
    expect(await s.attack('echo', { hello: 1 })).toMatchObject({ params: { hello: 1 } });
    expect((await s.t.summary(s.owner, 'hostile')).status).toBe('running');
  });

  sandboxed('cannot read the Studio’s database or its key file', async () => {
    expect(existsSync(path.join(s.t.dataDir, 'studio.db'))).toBe(true);
    expect(existsSync(path.join(s.t.dataDir, 'master.key'))).toBe(true);
    const report = await s.attack('readStudioData');
    const reads = Object.keys(report).filter((name) => name !== 'listing');
    expect(reads.length).toBe(26);
    expect(failed(report, reads)).toEqual(allRefused(reads));
    if (report.listing!.ok) expect(report.listing!.value).not.toEqual(expect.arrayContaining(['studio.db']));
    expect(await readdir(path.join(s.t.pluginDataDir, 'hostile'))).not.toEqual(expect.arrayContaining([expect.stringMatching(/^stolen/)]));
  });

  sandboxed('cannot read ~/.ssh, the agent CLIs’ credential folders, or anything else in the home directory', async () => {
    const report = await s.attack('readCredentials', { home: os.homedir(), sentinel: path.join(s.homeSentinel, 'secret.txt') });
    const listing = report['list home']!;
    const names = Object.keys(report).filter((name) => name !== 'list home');
    expect(names).toEqual(expect.arrayContaining(['list .ssh', 'list .claude', 'list .codex', 'read .ssh/id_rsa', 'read .claude.json', 'read .codex/auth.json', 'sentinel.readFileSync', 'passwd.readFileSync']));
    expect(failed(report, names)).toEqual(allRefused(names));
    if (listing.ok) {
      expect(listing.value).not.toEqual(expect.arrayContaining(['.ssh']));
      expect(listing.value).not.toEqual(expect.arrayContaining([path.basename(s.homeSentinel)]));
    }
  });

  sandboxed('cannot write anywhere but its own data folder', async () => {
    const token = `t${Date.now()}`;
    const entryBefore = await sha(path.join(s.t.pluginsDir, 'hostile', 'server.js'));
    const sdkFile = path.join(s.t.pluginsDir, 'node_modules', '@agent-studio', 'plugin-sdk', 'plugin.js');
    const sdkBefore = await sha(sdkFile);
    const report = await s.attack('writeOutside', { sentinelDir: s.homeSentinel, token });

    expect(report.control).toMatchObject({ ok: true });
    expect(existsSync(path.join(s.t.pluginDataDir, 'hostile', `allowed-${token}.txt`))).toBe(true);
    const others = Object.keys(report).filter((name) => name !== 'control');
    expect(others.length).toBe(14);
    expect(failed(report, others)).toEqual(allRefused(others));

    // And on the real file system nothing changed.
    for (const file of [
      path.join(s.t.pluginsDir, 'hostile', `pwned-${token}.txt`),
      path.join(s.t.dataDir, `pwned-${token}.txt`),
      path.join(s.t.pluginsDir, 'victim'),
      path.join(s.t.pluginDataDir, 'victim'),
      `/tmp/pwned-${token}.txt`,
      `/dev/shm/pwned-${token}.txt`,
      path.join(s.homeSentinel, `pwned-${token}.txt`),
      `/pwned-${token}.txt`,
    ]) {
      expect(existsSync(file), file).toBe(false);
    }
    expect(await sha(path.join(s.t.pluginsDir, 'hostile', 'server.js'))).toBe(entryBefore);
    expect(await sha(sdkFile)).toBe(sdkBefore);
    expect((await readdir(path.join(s.t.pluginsDir, 'hostile'))).sort()).toEqual(['panel', 'plugin.json', 'server.js']);
  });

  sandboxed('cannot start another program, a worker or a native add-on', async () => {
    const report = await s.attack('spawn');
    expect(Object.keys(report)).toEqual(['spawnSync', 'execSync', 'execFileSync', 'spawn', 'fork', 'worker', 'processBinding', 'dlopen']);
    expect(failed(report)).toEqual(allRefused(Object.keys(report)));
  });

  sandboxed('cannot open a network connection: not TCP, not UDP, not a local socket, not even a name lookup', async () => {
    const report = await s.attack('network', { port: s.tcp.port, unixSocket: s.unix.file });
    expect(Object.keys(report)).toEqual(expect.arrayContaining(['tcpLoopback', 'tcpLoopbackV6', 'globalFetch', 'httpGet', 'udp', 'unixSocket', 'dbus', 'dockerSocket', 'dns', 'listen']));
    // A datagram has no connection to refuse: inside the sandbox it can be "sent" — to the sandbox's own,
    // empty loopback. Whether it went anywhere is decided by the listener on the real one, below.
    const connecting = Object.keys(report).filter((name) => name !== 'udp');
    expect(failed(report, connecting)).toEqual(allRefused(connecting));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(s.tcp.connections).toBe(0);
    expect(s.udp.datagrams).toBe(0);
    expect(s.unix.connections).toBe(0);
    // The test's own connection does arrive: the counter is not simply broken.
    await new Promise<void>((resolve) => net.connect(s.tcp.port, '127.0.0.1').on('close', () => resolve()).on('error', () => resolve()));
    const probe = dgram.createSocket('udp4');
    await new Promise<void>((resolve) => probe.send('probe', s.tcp.port, '127.0.0.1', () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 100));
    probe.close();
    expect(s.tcp.connections).toBe(1);
    expect(s.udp.datagrams).toBe(1);
    s.tcp.connections = 0;
    s.udp.datagrams = 0;
  });

  sandboxed('cannot use the Studio to reach a private address, another host, or a granted name that resolves inward', async () => {
    // Every name lookup the server makes during this test is answered here: nothing leaves the machine,
    // and the one granted name that "resolves" does so to this machine's loopback, like a DNS rebinding attack.
    const lookup = vi.spyOn(dns, 'lookup').mockImplementation(((hostname: string, _options: unknown, callback: (error: Error | null, addresses: dns.LookupAddress[]) => void) => {
      if (hostname === 'rebind.example.com') callback(null, [{ address: '127.0.0.1', family: 4 }]);
      else callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), []);
    }) as never);
    try {
      const report = await s.attack('fetchPrivate', { port: s.tcp.port });
      const names = Object.keys(report);
      expect(names.length).toBe(28);
      expect(failed(report)).toEqual(allRefused(names));
      expect(s.tcp.connections).toBe(0);

      const code = (name: string) => report[name]!.code;
      expect(code(`http://127.0.0.1:${s.tcp.port}/`)).toBe('insecure_url');
      expect(code(`https://127.0.0.1:${s.tcp.port}/`)).toBe('port_not_allowed');
      expect(code('https://127.0.0.1/')).toBe('permission_denied');
      expect(code('https://localhost/')).toBe('permission_denied');
      expect(code('https://169.254.169.254/latest/meta-data/')).toBe('permission_denied');
      expect(code('https://not-granted.example.com/')).toBe('permission_denied');
      expect(code('https://allowed.example.com.evil.test/')).toBe('permission_denied');
      expect(code(`https://allowed.example.com@127.0.0.1:${s.tcp.port}/`)).toBe('invalid_url');
      expect(code(`https://allowed.example.com:${s.tcp.port}/`)).toBe('port_not_allowed');
      // Granted by name — and still refused, because the name leads to a private address.
      expect(code('https://rebind.example.com/')).toBe('address_not_allowed');
      expect(lookup).toHaveBeenCalledWith('rebind.example.com', expect.anything(), expect.anything());
      expect(code('header: host')).toBe('header_not_allowed');
      expect(code('header: cookie')).toBe('header_not_allowed');
      expect(code('header: split')).toBe('invalid_params');
      expect(code('method: CONNECT')).toBe('invalid_params');
    } finally {
      lookup.mockRestore();
    }
  });

  sandboxed('cannot call what it was not granted, what does not exist, or in the name of a call that is not in progress', async () => {
    await s.attack('rememberScope');
    const report = await s.attack('ungranted');
    expect(failed(report)).toEqual(allRefused(Object.keys(report)));
    const codes = Object.fromEntries(Object.entries(report).map(([name, attempt]) => [name, attempt.code]));
    expect(codes).toEqual({
      notify: 'permission_denied',
      'projects.list': 'permission_denied',
      'files.read': 'permission_denied',
      'unknown: host.secrets.get': 'unknown_method',
      'unknown: host.db.query': 'unknown_method',
      'unknown: host.plugins.enable': 'unknown_method',
      'unknown: host.exec': 'unknown_method',
      'unknown: tool.call': 'unknown_method',
      'unknown: __proto__': 'unknown_method',
      'no scope': 'invalid_scope',
      'forged scope': 'invalid_scope',
      'scope of start-up': 'invalid_scope',
      'scope of an earlier call': 'invalid_scope',
      'scope as object': 'invalid_scope',
      'params as array': 'invalid_scope',
    });
    // Nothing was written through any of those.
    expect(s.t.studio.context.db.all('SELECT key FROM plugin_storage WHERE plugin_id = ?', 'hostile')).toEqual([]);
  });

  sandboxed('cannot read, list or overwrite another plugin’s storage or files', async () => {
    await s.t.installAndEnable(s.owner, 'notes-counter');
    expect((await s.t.callTool(s.owner.userId!, 'plugin_notes_counter_add_note', { text: 'the victim’s private note' })).text).toBe('Saved note #1.');
    await writeFile(path.join(s.t.pluginDataDir, 'notes-counter', 'private.txt'), 'the victim’s private file');

    const report = await s.attack<Report>('otherStorage', { victim: 'notes-counter', key: 'notes' });
    for (const name of ['plain', 'named plugin', 'prefixed key', 'path key', 'sql key']) {
      expect(report[name], name).toEqual({ ok: true, value: { found: false } });
    }
    expect(report['list everything']).toEqual({ ok: true, value: { keys: [] } });
    expect(report['list like-wildcard']).toEqual({ ok: true, value: { keys: [] } });
    const files = Object.keys(report).filter((name) => name.startsWith('victimFile.') || name.startsWith('list victim'));
    expect(files.length).toBe(15);
    expect(failed(report, files)).toEqual(allRefused(files));
    expect(JSON.stringify(report)).not.toContain('private note');

    // Its "overwrite" landed in its own space; the victim's value is untouched.
    expect(report.overwrite).toEqual({ ok: true, value: {} });
    expect((await s.t.callTool(s.owner.userId!, 'plugin_notes_counter_count_notes', {})).text).toContain('the victim’s private note');
    const rows = s.t.studio.context.db.all<{ plugin_id: string; key: string }>('SELECT plugin_id, key FROM plugin_storage ORDER BY plugin_id, key');
    expect(rows).toEqual([
      { plugin_id: 'hostile', key: 'notes' },
      { plugin_id: 'notes-counter', key: 'notes' },
      { plugin_id: 'notes-counter', key: 'total' },
    ]);
  });

  sandboxed('sees none of the server’s environment: nothing named AGENT_STUDIO_*, no API key, nothing an operator passes to agents', async () => {
    const report = await s.attack<Record<string, unknown> & { env: Record<string, string>; argv: string[] }>('environment', { serverPid: process.pid });
    expect(Object.keys(report.env).sort()).toEqual(expect.arrayContaining(['HOME', 'LANG', 'NO_COLOR', 'PATH', 'TMPDIR']));
    expect(Object.keys(report.env).filter((name) => !['HOME', 'LANG', 'NO_COLOR', 'PATH', 'PWD', 'TMPDIR', 'TZ'].includes(name))).toEqual([]);
    expect(Object.keys(report.env).filter((name) => name.startsWith('AGENT_STUDIO_'))).toEqual([]);
    expect(report.env.HOME).toBe(path.join(s.t.pluginDataDir, 'hostile'));
    // Not even the server's PATH, which would name folders of the account it runs as.
    expect(report.env.PATH).toBe('/usr/bin:/bin');
    // The sandbox launcher adds the working directory, which is the same folder.
    if (report.env.PWD !== undefined) expect(report.env.PWD).toBe(report.env.HOME);
    const everything = JSON.stringify(report);
    for (const [name, value] of Object.entries(PLANTED)) {
      expect(everything.includes(value), name).toBe(false);
      expect(Object.keys(report.env), name).not.toContain(name);
    }
    // It cannot read the server's environment or memory out of /proc either, or even see that the server exists.
    const proc = report as unknown as Report;
    expect(failed(proc, ['procParentEnviron', 'procServerEnviron', 'procServerCmdline', 'procServerMem', 'signalServer'])).toEqual(
      allRefused(['procParentEnviron', 'procServerEnviron', 'procServerCmdline', 'procServerMem', 'signalServer']),
    );
    if (proc.otherProcesses!.ok) expect(proc.otherProcesses!.value).toBeLessThanOrEqual(4);
    expect(report.argv).toEqual(expect.arrayContaining(['--permission', '--no-addons']));
    expect(report.argv.some((flag) => flag.startsWith('--max-old-space-size='))).toBe(true);
    expect(report.argv.filter((flag) => flag.startsWith('--allow-') && !flag.startsWith('--allow-fs-'))).toEqual([]);
  });

  sandboxed('is refused storage beyond the limits', async () => {
    const report = await s.attack('storageLimits');
    expect(report).toMatchObject({
      hugeValue: { ok: false, code: 'too_large' },
      longKey: { ok: false, code: 'invalid_key' },
      controlKey: { ok: false, code: 'invalid_key' },
      fine: { ok: true },
    });
  });

  sandboxed('gets nothing a user owns in a hook, and is handed identifiers only', async () => {
    const created = (await s.owner.post<Project>('/api/projects', { name: 'bait', rootDir: path.join(s.t.workspace, 'bait'), createDirectory: true })).body;
    await writeFile(path.join(created.rootDir, 'README.md'), 'user data');
    await s.t.studio.context.services.plugins.settled();
    const report = await s.attack<Record<string, unknown>>('hookReport');
    expect(report).toMatchObject({
      event: 'project.created',
      payload: { projectId: created.id },
      // Not granted — and even if they were, a hook acts for no user.
      notify: { ok: false, code: 'permission_denied' },
      'projects.list': { ok: false, code: 'permission_denied' },
      'files.read': { ok: false, code: 'permission_denied' },
    });
    expect(JSON.stringify(report)).not.toContain('bait');
  });

  sandboxed('is told only an id and a display name about the person a call is for', async () => {
    const echoed = await s.attack<{ context: Record<string, unknown> }>('echo', {});
    expect(echoed.context).toEqual({ user: { id: s.owner.userId, displayName: 'owner' }, projectId: null, slot: 'home-tile' });
    const everything = JSON.stringify(echoed);
    expect(everything).not.toContain(s.owner.cookie!.split('=')[1]!);
    expect(everything).not.toContain(s.owner.csrfToken!);
    expect(everything).not.toContain(s.grant.panel);
  });
});

describe('a hostile plugin with a tool declared "read"', () => {
  let s: Scene;
  let skipped = false;
  beforeAll(async () => {
    if (!(await bubblewrapWorks())) {
      skipped = true;
      console.warn(SKIP_NO_BWRAP);
      return;
    }
    s = await scene('auto', []);
  });
  afterAll(async () => {
    await s?.close();
  });

  it('cannot change anything from inside that tool', async (context) => {
    if (skipped) return context.skip(SKIP_NO_BWRAP);
    expect(s.t.studio.context.agentTools.get('plugin_hostile_sneaky_read')!.effect).toBe('read');
    const result = await s.t.callTool(s.owner.userId!, 'plugin_hostile_sneaky_read', { stolen: 'what the model passed in' });
    expect(JSON.parse(result.text)).toMatchObject({
      'storage.set': { ok: false, code: 'read_only_call' },
      'storage.delete': { ok: false, code: 'read_only_call' },
      'http.fetch': { ok: false, code: 'read_only_call' },
      notify: { ok: false, code: 'permission_denied' },
      'storage.get': { ok: true, value: { found: false } },
    });
    expect(s.t.studio.context.db.all('SELECT key FROM plugin_storage WHERE plugin_id = ?', 'hostile')).toEqual([]);
  });

  it('loses the "read" label as soon as it is granted a way out', async (context) => {
    if (skipped) return context.skip(SKIP_NO_BWRAP);
    await s.owner.post('/api/plugins/hostile/disable');
    const again = await s.t.enable(s.owner, 'hostile', ['network:allowed.example.com']);
    expect(again.contributes.tools).toEqual([expect.objectContaining({ name: 'sneaky_read', declaredEffect: 'read', effect: 'write' })]);
    expect(s.t.studio.context.agentTools.get('plugin_hostile_sneaky_read')!.effect).toBe('write');
  });
});

describe('the same hostile plugin without bubblewrap', () => {
  let s: Scene;
  beforeAll(async () => {
    s = await scene('off', ['network:allowed.example.com', 'network:rebind.example.com']);
  });
  afterAll(async () => {
    await s?.close();
  });

  it('is reported as restricted, with the network and other processes named as not held back', () => {
    expect(s.isolation.level).toBe('restricted');
    expect(s.isolation.bubblewrap).toBe(false);
    expect(s.isolation.restricts).toMatchObject({ files: true, processes: true, otherProcesses: false });
    // Node 25 and later can also deny the network; older ones cannot. The report has to match the Node in use.
    expect(s.isolation.restricts.network).toBe(process.allowedNodeEnvironmentFlags.has('--allow-net'));
    expect(s.isolation.detail).toMatch(/Node does not promise/);
    // Without a contained network no tool is taken to be read-only.
    if (!s.isolation.restricts.network) {
      expect(s.t.studio.context.agentTools.get('plugin_hostile_sneaky_read')!.effect).toBe('write');
    }
  });

  it('still cannot read the Studio’s data or the home directory, write outside its folder, or start a program', async () => {
    const data = await s.attack('readStudioData');
    expect(failed(data)).toEqual(allRefused(Object.keys(data)));

    const credentials = await s.attack('readCredentials', { home: os.homedir(), sentinel: path.join(s.homeSentinel, 'secret.txt') });
    expect(failed(credentials)).toEqual(allRefused(Object.keys(credentials)));

    const token = `r${Date.now()}`;
    const writes = await s.attack('writeOutside', { sentinelDir: s.homeSentinel, token });
    expect(writes.control).toMatchObject({ ok: true });
    const others = Object.keys(writes).filter((name) => name !== 'control');
    expect(failed(writes, others)).toEqual(allRefused(others));
    expect(existsSync(`/tmp/pwned-${token}.txt`)).toBe(false);
    expect(existsSync(path.join(s.homeSentinel, `pwned-${token}.txt`))).toBe(false);

    const spawn = await s.attack('spawn');
    expect(failed(spawn)).toEqual(allRefused(Object.keys(spawn)));
  });

  it('still gets a scrubbed environment and the same answers from the Studio', async () => {
    const report = await s.attack<Record<string, unknown> & { env: Record<string, string> }>('environment', { serverPid: process.pid });
    expect(Object.keys(report.env).filter((name) => !['HOME', 'LANG', 'NO_COLOR', 'PATH', 'TMPDIR', 'TZ'].includes(name))).toEqual([]);
    const proc = report as unknown as Report;
    // Its own environment is its own; the server's, read through /proc, is refused by the permission model.
    expect(failed(proc, ['procParentEnviron', 'procServerEnviron', 'procServerCmdline', 'procServerMem'])).toEqual(
      allRefused(['procParentEnviron', 'procServerEnviron', 'procServerCmdline', 'procServerMem']),
    );
    const everything = JSON.stringify(report);
    for (const [name, value] of Object.entries(PLANTED)) expect(everything.includes(value), name).toBe(false);

    const ungranted = await s.attack('ungranted');
    expect(failed(ungranted)).toEqual(allRefused(Object.keys(ungranted)));
  });

  it('CAN reach the network and signal the server — which is exactly what the status says', async () => {
    const report = await s.attack('network', { port: s.tcp.port, unixSocket: s.unix.file });
    const environment = (await s.attack('environment', { serverPid: process.pid })) as unknown as Report;
    if (s.isolation.restricts.network) {
      expect(report.tcpLoopback!.ok).toBe(false);
      expect(s.tcp.connections).toBe(0);
    } else {
      // This is the documented weakness of running without bubblewrap, pinned down so that it cannot be forgotten.
      expect(report.tcpLoopback).toEqual({ ok: true, value: 'connected' });
      expect(report.unixSocket).toEqual({ ok: true, value: 'connected' });
      expect(report.udp).toEqual({ ok: true, value: 'sent' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(s.tcp.connections).toBeGreaterThanOrEqual(1);
      expect(s.udp.datagrams).toBeGreaterThanOrEqual(1);
      expect(s.unix.connections).toBeGreaterThanOrEqual(1);
    }
    expect(s.isolation.restricts.otherProcesses).toBe(false);
    expect(environment.signalServer!.ok).toBe(true);
  });
});

describe('the same hostile plugin under bubblewrap alone', () => {
  let s: Scene;
  let skipped = false;
  beforeAll(async () => {
    if (!(await bubblewrapWorks())) {
      skipped = true;
      console.warn(SKIP_NO_BWRAP);
      return;
    }
    for (const [name, value] of Object.entries(PLANTED)) {
      savedEnv[name] = process.env[name];
      process.env[name] = value;
    }
    // Node's permission flags are left out through a test seam, to see what the sandbox holds on its own.
    const t = await pluginStudio({ sources: { hostile: HOSTILE_PLUGIN }, plugins: { nodePermissions: false } });
    const owner = await t.owner();
    await t.installAndEnable(owner, 'hostile', []);
    const homeSentinel = await mkdtemp(path.join(os.homedir(), '.studio-plugin-hostile-test-'));
    await writeFile(path.join(homeSentinel, 'secret.txt'), 'a file in the real home directory');
    const tcp = { server: net.createServer(), port: 0, connections: 0 };
    tcp.server.on('connection', (socket) => {
      tcp.connections += 1;
      socket.destroy();
    });
    await new Promise<void>((resolve) => tcp.server.listen(0, '127.0.0.1', resolve));
    tcp.port = (tcp.server.address() as net.AddressInfo).port;
    const grant = await t.openPanel(owner, 'hostile', 'attack');
    s = {
      t,
      owner,
      grant,
      isolation: await t.isolation(owner),
      homeSentinel,
      tcp,
      udp: { socket: dgram.createSocket('udp4'), datagrams: 0 },
      unix: { server: net.createServer(), file: path.join(t.workspace, 'none.sock'), connections: 0 },
      attack: <T>(method: string, params: Record<string, unknown> = {}) => t.rpc<T>(owner, grant, method, params),
      async close() {
        await new Promise((resolve) => tcp.server.close(resolve));
        await rm(homeSentinel, { recursive: true, force: true });
        await t.close();
        for (const name of Object.keys(PLANTED)) {
          if (savedEnv[name] === undefined) delete process.env[name];
          else process.env[name] = savedEnv[name];
        }
      },
    };
  });
  afterAll(async () => {
    await s?.close();
  });

  it('is sandboxed, and says that Node’s own layer is missing', async (context) => {
    if (skipped) return context.skip(SKIP_NO_BWRAP);
    expect(s.isolation).toMatchObject({
      level: 'sandboxed',
      bubblewrap: true,
      nodePermissions: false,
      restricts: { files: true, processes: false, network: true, otherProcesses: true },
    });
    expect(s.isolation.detail).toMatch(/not available as a second layer/);
  });

  it('finds no Studio data, no home directory and no way to write or connect — because none of it is there', async (context) => {
    if (skipped) return context.skip(SKIP_NO_BWRAP);
    const data = await s.attack('readStudioData');
    const reads = Object.keys(data).filter((name) => name !== 'listing');
    expect(failed(data, reads)).toEqual(allRefused(reads));
    // The data directory exists inside the sandbox only as the path to the plugin's own two folders.
    expect(data.listing).toEqual({ ok: true, value: ['plugin-data', 'plugins'] });

    const credentials = await s.attack('readCredentials', { home: os.homedir(), sentinel: path.join(s.homeSentinel, 'secret.txt') });
    const names = Object.keys(credentials).filter((name) => name !== 'list home');
    expect(failed(credentials, names)).toEqual(allRefused(names));
    if (credentials['list home']!.ok) expect(credentials['list home']!.value).not.toEqual(expect.arrayContaining(['.ssh', path.basename(s.homeSentinel)]));

    const token = `b${Date.now()}`;
    const writes = await s.attack('writeOutside', { sentinelDir: s.homeSentinel, token });
    expect(writes.control).toMatchObject({ ok: true });
    const others = Object.keys(writes).filter((name) => name !== 'control');
    expect(failed(writes, others)).toEqual(allRefused(others));
    for (const file of [`/tmp/pwned-${token}.txt`, `/dev/shm/pwned-${token}.txt`, path.join(s.homeSentinel, `pwned-${token}.txt`), path.join(s.t.dataDir, `pwned-${token}.txt`)]) {
      expect(existsSync(file), file).toBe(false);
    }

    const network = await s.attack('network', { port: s.tcp.port, unixSocket: s.unix.file });
    const connecting = Object.keys(network).filter((name) => name !== 'udp');
    expect(failed(network, connecting)).toEqual(allRefused(connecting));
    expect(s.tcp.connections).toBe(0);

    const environment = (await s.attack('environment', { serverPid: process.pid })) as unknown as Report & { env: Record<string, string> };
    expect(failed(environment, ['procServerEnviron', 'procServerCmdline', 'procServerMem', 'signalServer'])).toEqual(
      allRefused(['procServerEnviron', 'procServerCmdline', 'procServerMem', 'signalServer']),
    );
    // Its "parent" is the sandbox launcher inside the same sandbox, whose environment is the plugin's own — not the server's.
    expect(environment.env.PATH).toBe('/usr/bin:/bin');
    const everything = JSON.stringify(environment);
    for (const [name, value] of Object.entries(PLANTED)) expect(everything.includes(value), name).toBe(false);
  });

  it('can start programs — but only the system’s own, inside the same empty sandbox', async (context) => {
    if (skipped) return context.skip(SKIP_NO_BWRAP);
    const spawn = await s.attack('spawn');
    // This is what the status means by "processes: false" when Node's layer is missing.
    expect(spawn.spawnSync!.ok).toBe(true);
    expect(spawn.dlopen!.ok).toBe(false);
    // A program started there is as confined as the plugin: it sees no more of the machine.
    expect(s.tcp.connections).toBe(0);
  });
});
