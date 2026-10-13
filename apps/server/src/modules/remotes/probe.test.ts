import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunOptions, RunResult } from '../../kernel/process.js';
import type { RemoteHostConfig } from './hosts-file.js';
import { type ProbeSettings, RemoteProber, classifyFailure, parseProbeOutput } from './probe.js';
import { PROBE_END_MARKER, PROBE_MARKER } from './ssh-command.js';

const host = (override: Partial<RemoteHostConfig> = {}): RemoteHostConfig => ({
  id: 'build-box',
  name: 'Build box',
  hostname: 'build.internal.example',
  user: null,
  port: 22,
  identityFile: null,
  jumpHost: null,
  defaultDirectory: null,
  agents: false,
  hostKeyChecking: 'strict',
  ...override,
});

const answer = (tools: Record<string, boolean>) =>
  [PROBE_MARKER, ...Object.entries(tools).map(([tool, found]) => `tool ${tool} ${found ? 'yes' : 'no'}`), PROBE_END_MARKER, ''].join('\n');
const ALL = answer({ tmux: true, git: true, claude: false, codex: true });
const ran = (result: Partial<RunResult>): RunResult => ({ code: 0, signal: null, stdout: '', stderr: '', truncated: false, timedOut: false, ...result });

describe('explaining a failed connection', () => {
  it.each([
    ['ssh: connect to host build.example port 22: Connection refused', 'connection_refused'],
    ['ssh: connect to host build.example port 22: Connection timed out', 'timeout'],
    ['ssh: connect to host 10.0.0.9 port 22: Operation timed out', 'timeout'],
    ['Connection timed out during banner exchange', 'timeout'],
    ['dev@build.example: Permission denied (publickey).', 'auth_failed'],
    ['Received disconnect from 10.0.0.9 port 22:2: Too many authentication failures', 'auth_failed'],
    ['dev@build.example: Permission denied (publickey,password).', 'auth_failed'],
    ['No ED25519 host key is known for build.example and you have requested strict checking.\nHost key verification failed.', 'host_key_failed'],
    ['@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\n@@@@@@@@@@@@@@@@@@@@@@@@@@@\nIT IS POSSIBLE THAT SOMEONE IS DOING SOMETHING NASTY!\nHost key verification failed.', 'host_key_failed'],
    ['ssh: Could not resolve hostname build.example: Name or service not known', 'dns_failed'],
    ['ssh: Could not resolve hostname build.example: Temporary failure in name resolution', 'dns_failed'],
    ['ssh: Could not resolve hostname build.example: nodename nor servname provided, or not known', 'dns_failed'],
    ['ssh: connect to host 10.9.9.9 port 22: Network is unreachable', 'network_unreachable'],
    ['ssh: connect to host 10.9.9.9 port 22: No route to host', 'network_unreachable'],
  ])('reads %j as %s', (stderr, code) => {
    const failure = classifyFailure({ code: 255, stderr, timedOut: false });
    expect(failure.code).toBe(code);
    // A fixed sentence: nothing of the raw output is passed on.
    expect(failure.message).not.toContain('build.example');
    expect(failure.message).not.toContain('@');
    expect(failure.message.length).toBeLessThanOrEqual(120);
    expect(failure.message).not.toContain('\n');
  });

  it('treats our own time limit as a timeout whatever was printed', () => {
    expect(classifyFailure({ code: null, stderr: 'Permission denied', timedOut: true })).toEqual({ code: 'timeout', message: 'The connection timed out.' });
  });

  it('reduces anything else to one cleaned, shortened line', () => {
    const noisy = `debug1: something\nkex_exchange_identification: Connection closed by remote host${String.fromCharCode(27)}[31m\nConnection closed by 10.0.0.9 port 22\n\n`;
    expect(classifyFailure({ code: 255, stderr: noisy, timedOut: false })).toEqual({ code: 'ssh_failed', message: 'SSH failed: Connection closed by 10.0.0.9 port 22' });
    const long = classifyFailure({ code: 255, stderr: `error: ${'x'.repeat(500)}`, timedOut: false });
    expect(long.message.length).toBeLessThanOrEqual(120);
    expect(long.message.endsWith('…')).toBe(true);
    expect(classifyFailure({ code: 255, stderr: '', timedOut: false })).toEqual({ code: 'ssh_failed', message: 'SSH failed.' });
    // Something that looks like a credential does not travel in an error message.
    const leaky = classifyFailure({ code: 255, stderr: 'proxy said: token=ghp_0123456789abcdefghijklmnopqrstuvwxyz', timedOut: false });
    expect(leaky.message).not.toContain('ghp_0123456789');
    // eslint-disable-next-line no-control-regex
    expect(classifyFailure({ code: 255, stderr: `bell${String.fromCharCode(7)}tab\there`, timedOut: false }).message).not.toMatch(/[\u0000-\u001f]/);
  });
});

describe('reading the answer of the check', () => {
  it('understands a complete answer, also with a banner around it and other line endings', () => {
    expect(parseProbeOutput(ALL)).toEqual({ tmux: true, git: true, claude: false, codex: true });
    expect(parseProbeOutput(`Welcome to build-box!\r\nLast login: yesterday\r\n${ALL.replaceAll('\n', '\r\n')}bye\r\n`)).toEqual({ tmux: true, git: true, claude: false, codex: true });
  });

  it.each([
    ['nothing', ''],
    ['a banner only', 'Welcome!\n'],
    ['an answer without its end', ALL.replace(PROBE_END_MARKER, '')],
    ['an answer without its beginning', ALL.replace(PROBE_MARKER, '')],
    ['an answer that lacks a tool', answer({ tmux: true, git: true, claude: true })],
    ['an answer with something else in place of a tool', ALL.replace('tool git yes', 'tool git maybe')],
    ['the markers in the wrong order', `${PROBE_END_MARKER}\ntool tmux yes\n${PROBE_MARKER}\n`],
  ])('rejects %s', (_what, stdout) => {
    expect(parseProbeOutput(stdout)).toBeNull();
  });
});

describe('checking a host', () => {
  let directory: string;
  let key: string;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-probe-'));
    key = path.join(directory, 'id_test');
    await writeFile(key, 'not a real key\n', { mode: 0o600 });
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** A prober whose "SSH client" is a function, so no process is ever started. */
  function bench(respond: (args: readonly string[], options: RunOptions) => Promise<RunResult> | RunResult, settings: Partial<ProbeSettings> = {}, ssh: string | null = '/usr/bin/ssh') {
    const runs: Array<{ file: string; args: readonly string[]; options: RunOptions }> = [];
    const prober = new RemoteProber(
      {
        run: async (file, args, options) => {
          runs.push({ file, args, options });
          return respond(args, options);
        },
        environment: () => ({ PATH: '/usr/bin', HOME: '/home/studio' }),
        findSsh: () => ssh,
      },
      settings,
    );
    return { prober, runs };
  }

  it('reports a reachable host with its tools and how long it took', async () => {
    const { prober, runs } = bench(() => ran({ stdout: ALL }));
    const status = await prober.status(host(), null);
    expect(status).toMatchObject({ hostId: 'build-box', reachable: true, tools: { tmux: true, git: true, claude: false, codex: true }, failure: null, cached: false });
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
    expect(status.checkedAt).toBeLessThanOrEqual(Date.now());

    // One run of the SSH client: non-interactive, time-limited, in a neutral directory, with the given environment.
    expect(runs).toHaveLength(1);
    expect(runs[0]!.file).toBe('/usr/bin/ssh');
    expect(runs[0]!.options).toMatchObject({ cwd: '/', timeoutMs: 12_000, env: { PATH: '/usr/bin', HOME: '/home/studio' } });
    const args = runs[0]!.args;
    expect(args.slice(0, 2)).toEqual(['-F', 'none']);
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ConnectTimeout=6');
    expect(args.slice(-3, -1)).toEqual(['--', 'build.internal.example']);
    expect(args[args.length - 1]).toContain(PROBE_MARKER);
  });

  it('answers from the cache within the cache window, and connects again after it', async () => {
    const { prober, runs } = bench(() => ran({ stdout: ALL }), { cacheMs: 150, minIntervalMs: 50 });
    const first = await prober.status(host(), null);
    const second = await prober.status(host(), null);
    expect(second).toEqual({ ...first, cached: true });
    expect(runs).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect((await prober.status(host(), null)).cached).toBe(false);
    expect(runs).toHaveLength(2);
    expect(prober.connections).toBe(2);
  });

  it('caches failures as well, so an unreachable host is not hammered', async () => {
    const { prober, runs } = bench(() => ran({ code: 255, stderr: 'ssh: connect to host x port 22: Connection refused' }));
    const first = await prober.status(host(), null);
    expect(first).toMatchObject({ reachable: false, latencyMs: null, tools: null, failure: { code: 'connection_refused' }, cached: false });
    expect(await prober.status(host(), null)).toMatchObject({ reachable: false, cached: true });
    expect(runs).toHaveLength(1);
  });

  it('makes one connection for any number of simultaneous requests', async () => {
    let release: (result: RunResult) => void = () => {};
    const { prober, runs } = bench(() => new Promise<RunResult>((resolve) => (release = resolve)));
    const pending = Array.from({ length: 20 }, () => prober.status(host(), null));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runs).toHaveLength(1);
    release(ran({ stdout: ALL }));
    const results = await Promise.all(pending);
    expect(runs).toHaveLength(1);
    expect(new Set(results.map((result) => JSON.stringify({ ...result, cached: false }))).size).toBe(1);
    expect(results.every((result) => result.reachable)).toBe(true);
    // And a further request right after is served from the cache.
    expect((await prober.status(host(), null)).cached).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it('honours a requested re-check, but not more often than the minimum interval', async () => {
    const { prober, runs } = bench(() => ran({ stdout: ALL }), { cacheMs: 60_000, minIntervalMs: 120 });
    await prober.status(host(), null);
    expect((await prober.status(host(), null, { refresh: true })).cached).toBe(true);
    expect(runs).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 160));
    expect((await prober.status(host(), null, { refresh: true })).cached).toBe(false);
    expect(runs).toHaveLength(2);
    // Without the request the cache still holds.
    expect((await prober.status(host(), null)).cached).toBe(true);
  });

  it('checks again when the configuration of the host changed', async () => {
    const { prober, runs } = bench(() => ran({ stdout: ALL }));
    await prober.status(host(), null);
    expect((await prober.status(host({ port: 2222 }), null)).cached).toBe(false);
    expect(runs).toHaveLength(2);
    const bastion = host({ id: 'bastion', hostname: 'bastion.example' });
    expect((await prober.status(host({ port: 2222, jumpHost: 'bastion' }), bastion)).cached).toBe(false);
    expect((await prober.status(host({ port: 2222, jumpHost: 'bastion' }), { ...bastion, port: 2200 })).cached).toBe(false);
    expect(runs).toHaveLength(4);
    expect(runs[3]!.args.join(' ')).toContain('-p 2200 -W');
  });

  it('forgets hosts that are no longer configured', async () => {
    const { prober, runs } = bench(() => ran({ stdout: ALL }));
    await prober.status(host(), null);
    await prober.status(host({ id: 'other' }), null);
    prober.retain(new Set(['other']));
    expect((await prober.status(host({ id: 'other' }), null)).cached).toBe(true);
    expect((await prober.status(host(), null)).cached).toBe(false);
    expect(runs).toHaveLength(3);
  });

  it('does not start anything when there is no SSH client or the key cannot be read', async () => {
    const noClient = bench(() => ran({ stdout: ALL }), {}, null);
    expect(await noClient.prober.status(host(), null)).toMatchObject({ reachable: false, failure: { code: 'ssh_missing', message: 'No SSH client is installed on this computer.' } });
    expect(noClient.runs).toHaveLength(0);

    const noKey = bench(() => ran({ stdout: ALL }));
    expect(await noKey.prober.status(host({ identityFile: path.join(directory, 'absent') }), null)).toMatchObject({ reachable: false, failure: { code: 'identity_unreadable' } });
    const bastion = host({ id: 'bastion', hostname: 'bastion.example', identityFile: path.join(directory, 'absent-too') });
    expect(await noKey.prober.status(host({ id: 'inner', jumpHost: 'bastion', identityFile: key }), bastion)).toMatchObject({ failure: { code: 'identity_unreadable' } });
    expect(noKey.runs).toHaveLength(0);
    expect(noKey.prober.connections).toBe(0);

    const withKey = bench(() => ran({ stdout: ALL }));
    expect((await withKey.prober.status(host({ identityFile: key }), null)).reachable).toBe(true);
    expect(withKey.runs[0]!.args).toContain(key);
  });

  it('reports a time-out, a client that vanished, and a client that cannot be started', async () => {
    expect((await bench(() => ran({ code: null, signal: 'SIGTERM', timedOut: true })).prober.status(host(), null)).failure).toEqual({ code: 'timeout', message: 'The connection timed out.' });
    expect((await bench(() => ran({ code: null, signal: 'SIGKILL', stderr: '' })).prober.status(host(), null)).failure).toEqual({ code: 'ssh_failed', message: 'SSH failed.' });
    const gone = bench(() => Promise.reject(Object.assign(new Error('spawn ssh ENOENT'), { code: 'ENOENT' })));
    expect((await gone.prober.status(host(), null)).failure?.code).toBe('ssh_missing');
    const broken = bench(() => Promise.reject(new Error('EACCES /usr/bin/ssh secret-detail')));
    expect((await broken.prober.status(host(), null)).failure).toEqual({ code: 'ssh_failed', message: 'SSH failed: the SSH client could not be started.' });
  });

  it('says the host answered when the connection worked but the check did not', async () => {
    for (const result of [ran({ stdout: 'Welcome to a restricted shell\n' }), ran({ code: 127, stderr: 'sh: not found' }), ran({ code: 1 })]) {
      const status = await bench(() => result).prober.status(host(), null);
      expect(status).toMatchObject({ reachable: true, tools: null, failure: { code: 'unexpected_output' } });
      expect(status.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('runs only a few checks at the same time', async () => {
    let active = 0;
    let peak = 0;
    const { prober } = bench(
      async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        return ran({ stdout: ALL });
      },
      { maxConcurrent: 2 },
    );
    const results = await Promise.all(Array.from({ length: 7 }, (_unused, index) => prober.status(host({ id: `host-${index}` }), null)));
    expect(results.every((result) => result.reachable)).toBe(true);
    expect(peak).toBe(2);
    expect(prober.connections).toBe(7);
  });
});
