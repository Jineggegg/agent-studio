import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findExecutable } from '../terminal/login-shell.js';
import type { RemoteHostConfig } from './hosts-file.js';
import { parseProbeOutput } from './probe.js';
import {
  PROBE_SCRIPT,
  SESSION_SCRIPT,
  type SshInvocation,
  buildSshArgs,
  deriveSessionName,
  deriveUserTag,
  probeCommand,
  remoteShellCommand,
  sessionCommand,
  shellQuote,
} from './ssh-command.js';

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

const invocation = (override: Partial<SshInvocation> = {}): SshInvocation => ({
  mode: 'probe',
  host: host(),
  jump: null,
  remoteCommand: 'exec sh -c true',
  connectTimeoutSeconds: 6,
  sshProgram: '/usr/bin/ssh',
  ...override,
});

const FIXED = [
  'BatchMode=yes',
  'ConnectTimeout=6',
  'ConnectionAttempts=1',
  'StrictHostKeyChecking=yes',
  'UpdateHostKeys=no',
  'PasswordAuthentication=no',
  'KbdInteractiveAuthentication=no',
  'PreferredAuthentications=publickey',
  'ForwardAgent=no',
  'ForwardX11=no',
  'Tunnel=no',
  'PermitLocalCommand=no',
  'ControlMaster=no',
  'ControlPath=none',
];
const withFlags = (options: string[]) => options.flatMap((option) => ['-o', option]);

/** Reads an argument list the way the SSH client's option parser would, and fails on anything unexpected. */
function dissect(args: string[]) {
  expect(args.slice(0, 2)).toEqual(['-F', 'none']);
  const end = args.indexOf('--');
  expect(end).toBeGreaterThan(2);
  const options: Record<string, string> = {};
  const flags: Record<string, string> = {};
  let noStdin = false;
  for (let index = 2; index < end; ) {
    const flag = args[index]!;
    if (flag === '-n') {
      noStdin = true;
      index += 1;
      continue;
    }
    expect(['-o', '-i', '-p', '-l'], `unexpected flag ${flag}`).toContain(flag);
    const value = args[index + 1]!;
    if (flag === '-o') {
      const equals = value.indexOf('=');
      expect(equals).toBeGreaterThan(0);
      expect(options[value.slice(0, equals)], `option given twice: ${value}`).toBeUndefined();
      options[value.slice(0, equals)] = value.slice(equals + 1);
    } else {
      expect(flags[flag]).toBeUndefined();
      flags[flag] = value;
    }
    index += 2;
  }
  // After "--": exactly the destination and the command.
  expect(args.length).toBe(end + 3);
  return { options, flags, noStdin, destination: args[end + 1]!, command: args[end + 2]! };
}

const ALLOWED_OPTIONS = new Set([
  ...FIXED.map((option) => option.slice(0, option.indexOf('='))),
  'IdentitiesOnly',
  'ClearAllForwardings',
  'ProxyCommand',
  'RequestTTY',
  'EscapeChar',
  'ServerAliveInterval',
  'ServerAliveCountMax',
  'LogLevel',
]);

describe('the SSH argument list', () => {
  it('is exactly this for a status check of a plain host', () => {
    expect(buildSshArgs(invocation())).toEqual([
      '-F',
      'none',
      ...withFlags([...FIXED, 'ClearAllForwardings=yes', 'ProxyCommand=none', 'RequestTTY=no', 'LogLevel=ERROR']),
      '-p',
      '22',
      '-n',
      '--',
      'build.internal.example',
      'exec sh -c true',
    ]);
  });

  it('is exactly this for a terminal session with every setting used', () => {
    const full = host({ user: 'dev', port: 2222, identityFile: '/home/studio/.ssh/id_ed25519', hostKeyChecking: 'accept-new' });
    expect(buildSshArgs(invocation({ mode: 'session', host: full, connectTimeoutSeconds: 10 }))).toEqual([
      '-F',
      'none',
      ...withFlags([
        ...FIXED.map((option) => (option === 'ConnectTimeout=6' ? 'ConnectTimeout=10' : option === 'StrictHostKeyChecking=yes' ? 'StrictHostKeyChecking=accept-new' : option)),
        'IdentitiesOnly=yes',
        'ClearAllForwardings=yes',
        'ProxyCommand=none',
        'RequestTTY=yes',
        'EscapeChar=none',
        'ServerAliveInterval=30',
        'ServerAliveCountMax=3',
      ]),
      '-i',
      '/home/studio/.ssh/id_ed25519',
      '-p',
      '2222',
      '-l',
      'dev',
      '--',
      'build.internal.example',
      'exec sh -c true',
    ]);
  });

  it('reaches a host behind a jump host through a second, equally locked-down client', () => {
    const bastion = host({ id: 'bastion', hostname: 'bastion.example', user: 'jump', port: 2200, identityFile: '/etc/studio/keys/bastion', hostKeyChecking: 'accept-new' });
    const inner = host({ id: 'inner', hostname: '10.0.0.5', jumpHost: 'bastion' });
    const { options, destination } = dissect(buildSshArgs(invocation({ host: inner, jump: bastion })));
    expect(destination).toBe('10.0.0.5');
    expect(options.ProxyCommand).toBe(
      [
        '/usr/bin/ssh -F none',
        ...FIXED.map((option) => `-o ${option === 'StrictHostKeyChecking=yes' ? 'StrictHostKeyChecking=accept-new' : option}`),
        '-o IdentitiesOnly=yes -o LogLevel=ERROR -o ProxyCommand=none',
        "-i /etc/studio/keys/bastion -p 2200 -l jump -W '[%h]:%p' -- bastion.example",
      ].join(' '),
    );
    // The target's own settings stay the target's.
    expect(options.StrictHostKeyChecking).toBe('yes');
    expect(options.IdentitiesOnly).toBeUndefined();
  });

  it('keeps its shape for every combination of settings', () => {
    const bastions = [null, host({ id: 'bastion', hostname: 'bastion.example' }), host({ id: 'bastion', hostname: '2001:db8::7', user: 'j', port: 2200, identityFile: '/k/j', hostKeyChecking: 'accept-new' })];
    let combinations = 0;
    for (const mode of ['probe', 'session'] as const)
      for (const user of [null, 'dev'])
        for (const port of [22, 2222])
          for (const identityFile of [null, '/keys/id_ed25519'])
            for (const hostKeyChecking of ['strict', 'accept-new'] as const)
              for (const hostname of ['build.internal.example', '192.0.2.7', '2001:db8::1'])
                for (const jump of bastions) {
                  combinations += 1;
                  const target = host({ user, port, identityFile, hostKeyChecking, hostname, jumpHost: jump?.id ?? null });
                  const command = sessionCommand({ program: 'shell', directory: '/srv/work', sessionName: 'studio-shell-0123456789ab', userTag: 'u0123456789ab' });
                  const { options, flags, noStdin, destination, command: sent } = dissect(buildSshArgs(invocation({ mode, host: target, jump, remoteCommand: command })));

                  expect(destination).toBe(hostname);
                  expect(sent).toBe(command);
                  expect(flags).toEqual({ '-p': String(port), ...(user ? { '-l': user } : {}), ...(identityFile ? { '-i': identityFile } : {}) });
                  expect(noStdin).toBe(mode === 'probe');
                  for (const name of Object.keys(options)) expect(ALLOWED_OPTIONS.has(name), name).toBe(true);
                  // Safe by default, whatever the combination.
                  expect(options).toMatchObject({
                    BatchMode: 'yes',
                    StrictHostKeyChecking: hostKeyChecking === 'strict' ? 'yes' : 'accept-new',
                    PasswordAuthentication: 'no',
                    KbdInteractiveAuthentication: 'no',
                    PreferredAuthentications: 'publickey',
                    ForwardAgent: 'no',
                    ForwardX11: 'no',
                    Tunnel: 'no',
                    PermitLocalCommand: 'no',
                    ClearAllForwardings: 'yes',
                    ControlMaster: 'no',
                    ControlPath: 'none',
                    RequestTTY: mode === 'session' ? 'yes' : 'no',
                  });
                  expect(options.IdentitiesOnly).toBe(identityFile ? 'yes' : undefined);
                  expect(options.ProxyCommand === 'none').toBe(jump === null);
                  if (jump) {
                    expect(options.ProxyCommand!.endsWith(` -W '[%h]:%p' -- ${jump.hostname}`)).toBe(true);
                    expect(options.ProxyCommand).not.toMatch(/StrictHostKeyChecking=(no|off|ask)\b/);
                    // Apart from the one quoted token, nothing in it means anything to a shell.
                    expect(options.ProxyCommand!.replace("'[%h]:%p'", 'X')).toMatch(/^[A-Za-z0-9._/@:+=, -]+$/);
                  }
                }
    expect(combinations).toBe(2 * 2 * 2 * 2 * 2 * 3 * 3);
  });

  it('can never turn host key checking off', () => {
    for (const hostKeyChecking of ['no', 'off', 'ask', 'false', '', 'yes -o ProxyCommand=evil', undefined]) {
      expect(() => buildSshArgs(invocation({ host: host({ hostKeyChecking: hostKeyChecking as never }) }))).toThrow('not safe');
    }
    for (const mode of ['probe', 'session'] as const) {
      const args = buildSshArgs(invocation({ mode, host: host({ hostKeyChecking: 'accept-new' }) }));
      expect(args.filter((arg) => arg.startsWith('StrictHostKeyChecking='))).toEqual(['StrictHostKeyChecking=accept-new']);
    }
  });

  // The hosts file is validated when it is read (hosts-file.test.ts). These
  // cases hand the builder a configuration that skipped that check.
  it.each<[string, Partial<RemoteHostConfig>]>([
    ['a host name that is an option', { hostname: '-oProxyCommand=touch /tmp/pwned' }],
    ['a host name with a space', { hostname: 'host -oProxyCommand=evil' }],
    ['a host name with a line break', { hostname: 'host\nProxyCommand evil' }],
    ['a host name with a user part', { hostname: 'root@host' }],
    ['a host name with shell syntax', { hostname: '$(reboot)' }],
    ['an empty host name', { hostname: '' }],
    ['a user that is an option', { user: '-oProxyCommand=evil' }],
    ['a user with a space', { user: 'dev -oProxyCommand=evil' }],
    ['a user with shell syntax', { user: 'dev;reboot' }],
    ['a port that is not a number', { port: '22' as never }],
    ['a port that carries an option', { port: '22 -oProxyCommand=evil' as never }],
    ['a port out of range', { port: 0 }],
    ['a fractional port', { port: 22.5 }],
    ['a key path that is an option', { identityFile: '-oProxyCommand=evil' }],
    ['a relative key path', { identityFile: 'id_ed25519' }],
    ['a key path with a space', { identityFile: '/keys/id -oProxyCommand=evil' }],
    ['a key path with a percent token', { identityFile: '/keys/%h' }],
    ['a key path with a parent step', { identityFile: '/keys/../../etc/shadow' }],
    ['an id that is not a slug', { id: '../x' }],
  ])('refuses %s instead of emitting it', (_what, override) => {
    expect(() => buildSshArgs(invocation({ host: host(override) }))).toThrow('not safe to pass to the SSH client');
    // The same holds when the bad entry is the jump host.
    const bastion = host({ id: 'bastion', hostname: 'bastion.example', ...override, ...(override.id ? {} : { id: 'bastion' }) });
    expect(() => buildSshArgs(invocation({ host: host({ jumpHost: bastion.id }), jump: bastion }))).toThrow();
  });

  it('refuses inconsistent or unusable invocations', () => {
    const bastion = host({ id: 'bastion', hostname: 'bastion.example' });
    expect(() => buildSshArgs(invocation({ host: host({ jumpHost: 'bastion' }) }))).toThrow('jump host does not match');
    expect(() => buildSshArgs(invocation({ jump: bastion }))).toThrow('jump host does not match');
    expect(() => buildSshArgs(invocation({ host: host({ jumpHost: 'other' }), jump: bastion }))).toThrow('jump host does not match');
    expect(() => buildSshArgs(invocation({ host: host({ jumpHost: 'bastion' }), jump: { ...bastion, jumpHost: 'third' } }))).toThrow('cannot itself be reached');
    for (const sshProgram of ['/opt/my tools/ssh', '/usr/bin/ssh;reboot', '$(reboot)', "/usr/bin/ss'h", 'ssh -oProxyCommand=x']) {
      expect(() => buildSshArgs(invocation({ host: host({ jumpHost: 'bastion' }), jump: bastion, sshProgram }))).toThrow('without special characters');
    }
    for (const remoteCommand of ['', 'one\ntwo', 'one\rtwo', 'nul\0byte']) {
      expect(() => buildSshArgs(invocation({ remoteCommand }))).toThrow('single line');
    }
    for (const connectTimeoutSeconds of [0, -1, 1.5, 1000, Number.NaN]) {
      expect(() => buildSshArgs(invocation({ connectTimeoutSeconds }))).toThrow('time limit');
    }
  });

  const realSsh = findExecutable('ssh', process.env.PATH);
  // `ssh -G` only parses its options and prints the resulting configuration; it connects to nothing.
  it.runIf(realSsh !== null)('is accepted, option for option, by the real SSH client (parse only, no connection)', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-ssh-g-'));
    try {
      const key = path.join(directory, 'id_test');
      await writeFile(key, 'not a real key\n', { mode: 0o600 });
      const bastion = host({ id: 'bastion', hostname: 'bastion.invalid', user: 'jump', port: 2200, identityFile: key });
      const target = host({ hostname: 'target.invalid', user: 'dev', port: 2222, identityFile: key, hostKeyChecking: 'accept-new', jumpHost: 'bastion' });
      for (const mode of ['probe', 'session'] as const) {
        const args = buildSshArgs(invocation({ mode, host: target, jump: bastion, remoteCommand: probeCommand(), sshProgram: realSsh! }));
        const printed = spawnSync(realSsh!, ['-G', ...args], { encoding: 'utf8', timeout: 10_000 });
        expect(printed.status, printed.stderr).toBe(0);
        expect(printed.stderr).not.toMatch(/bad configuration option|unsupported option|unknown option|illegal option/i);
        const config = new Map(printed.stdout.split('\n').map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]));
        expect(config.get('hostname')).toBe('target.invalid');
        expect(config.get('user')).toBe('dev');
        expect(config.get('port')).toBe('2222');
        expect(config.get('batchmode')).toBe('yes');
        expect(config.get('stricthostkeychecking')).toBe('accept-new');
        expect(config.get('passwordauthentication')).toBe('no');
        // Older clients print this setting under its former name.
        expect(config.get('kbdinteractiveauthentication') ?? config.get('challengeresponseauthentication')).toBe('no');
        expect(config.get('preferredauthentications')).toBe('publickey');
        expect(config.get('forwardagent')).toBe('no');
        expect(config.get('forwardx11')).toBe('no');
        expect(config.get('permitlocalcommand')).toBe('no');
        expect(config.get('clearallforwardings')).toBe('yes');
        expect(config.get('identitiesonly')).toBe('yes');
        expect(config.get('connecttimeout')).toBe('6');
        // Only the configured key, none of the account's default keys.
        expect(printed.stdout.split('\n').filter((line) => line.startsWith('identityfile '))).toEqual([`identityfile ${key}`]);
        expect(config.get('proxycommand')).toContain(`-W '[%h]:%p' -- bastion.invalid`);
        expect(config.get('proxycommand')!.startsWith(`${realSsh} -F none -o BatchMode=yes `)).toBe(true);
        if (mode === 'session') expect(config.get('escapechar')).toBe('none');
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const HOSTILE_VALUES = [
  "it's",
  "'; touch CANARY; '",
  '"; touch CANARY; "',
  '$(touch CANARY)',
  '`touch CANARY`',
  '; touch CANARY',
  '&& touch CANARY',
  '| touch CANARY',
  '> CANARY',
  'line one\ntouch CANARY',
  'carriage\rreturn',
  '-rf',
  '--help',
  '-oProxyCommand=touch CANARY',
  '$HOME',
  '${IFS}touch${IFS}CANARY',
  '~root',
  '*',
  '?',
  '[a-z]',
  '!!',
  '#comment',
  'back\\slash',
  "'\\''",
  "''''",
  '\\',
  ' leading and trailing ',
  '\t',
  '',
  'héllo 世界 🙂',
  `${String.fromCharCode(27)}[2J`,
  'x'.repeat(20_000),
];

describe('quoting for the remote shell', () => {
  let scratch: string;
  beforeEach(async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-quote-'));
  });
  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  /** Runs one line the way the remote side does: handed to a shell as a single string. */
  const shell = (line: string) => spawnSync('/bin/sh', ['-c', line], { cwd: scratch, encoding: 'utf8', timeout: 10_000 });

  it('writes a single quote the only way a shell accepts inside single quotes', () => {
    expect(shellQuote('plain')).toBe("'plain'");
    expect(shellQuote('')).toBe("''");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote('$(id) `id` \\ "x"')).toBe('\'$(id) `id` \\ "x"\'');
    expect(() => shellQuote('nul\0byte')).toThrow('NUL');
  });

  it.each(HOSTILE_VALUES.map((value) => [JSON.stringify(value).slice(0, 60), value]))('passes %s through a real shell unchanged and unexecuted', (_label, value) => {
    const result = shell(`printf '%s' ${shellQuote(value)}`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(value);
    expect(existsSync(path.join(scratch, 'CANARY'))).toBe(false);
  });

  it('delivers every parameter of a remote command as exactly one argument', () => {
    const script = 'printf "%s\\n" "$#"; for value in "$@"; do printf "<%s>" "$value"; done';
    const values = HOSTILE_VALUES.filter((value) => value.length < 100);
    const result = shell(remoteShellCommand(script, values));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${values.length}\n${values.map((value) => `<${value}>`).join('')}`);
    expect(existsSync(path.join(scratch, 'CANARY'))).toBe(false);
    // The script itself survives too, quotes and all.
    expect(shell(remoteShellCommand(`printf '%s' "it's $1"`, ['fine'])).stdout).toBe("it's fine");
  });

  it('keeps the fixed scripts free of anything a login shell could trip over', () => {
    for (const script of [PROBE_SCRIPT, SESSION_SCRIPT]) {
      expect(script).not.toMatch(/['\\!\n\r]/);
      expect(script.startsWith('PATH="$HOME/.local/bin:')).toBe(true);
      // So quoting it is trivial: the script between one pair of single quotes.
      expect(remoteShellCommand(script, []).startsWith(`exec sh -c '${script}' agent-studio`)).toBe(true);
    }
    expect(probeCommand()).toBe(`exec sh -c '${PROBE_SCRIPT}' agent-studio`);
  });
});

describe('what runs on the remote side', () => {
  // The scripts are run here by a local `sh`, in a sandbox whose HOME and PATH
  // are temporary directories. No SSH client is involved.
  let root: string;
  let home: string;
  let bin: string;
  let localBin: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-remote-'));
    home = path.join(root, 'home');
    bin = path.join(root, 'bin');
    localBin = path.join(home, '.local', 'bin');
    await mkdir(localBin, { recursive: true });
    await mkdir(bin);
    await mkdir(path.join(root, 'work', 'project-1'), { recursive: true });
    // Only the handful of programs the scripts need: nothing else of this machine is reachable by name.
    for (const tool of ['sh', 'mkdir', 'chmod', 'env']) await symlink(findExecutable(tool, '/usr/bin:/bin')!, path.join(bin, tool));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const fake = (name: string, body: string, directory = localBin) => writeFile(path.join(directory, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  const fakeTmux = () => fake('tmux', '{ printf "cwd=%s\\n" "$PWD"; for value in "$@"; do printf "arg=%s\\n" "$value"; done; } > "$HOME/tmux.log"');
  const run = (line: string, environment: Record<string, string> = {}) =>
    spawnSync('/bin/sh', ['-c', line], { cwd: root, env: { HOME: home, PATH: bin, ...environment }, encoding: 'utf8', timeout: 10_000 });
  const log = (name: string) => readFileSync(path.join(home, name), 'utf8').trim().split('\n');
  const session = (program: 'shell' | 'claude' | 'codex', directory: string | null) =>
    sessionCommand({ program, directory, sessionName: 'studio-test-0123456789ab', userTag: 'u0123456789ab' });
  /** A machine where tmux sits in a directory the script itself adds to PATH cannot play "a host without tmux". */
  const tmuxElsewhere = ['/usr/local/bin/tmux', '/opt/homebrew/bin/tmux'].some((candidate) => existsSync(candidate));

  it('reports which tools the host has', async () => {
    // The script also looks in two system-wide directories; allow for a machine that has the tools there.
    const systemWide = (tool: string) => ['/usr/local/bin', '/opt/homebrew/bin'].some((directory) => existsSync(path.join(directory, tool)));
    const bare = run(probeCommand());
    expect(bare.status).toBe(0);
    expect(parseProbeOutput(bare.stdout)).toEqual({ tmux: systemWide('tmux'), git: systemWide('git'), claude: systemWide('claude'), codex: systemWide('codex') });

    await fakeTmux();
    await fake('git', 'exit 0');
    const withSome = run(probeCommand());
    expect(withSome.status).toBe(0);
    expect(parseProbeOutput(withSome.stdout)).toEqual({ tmux: true, git: true, claude: systemWide('claude'), codex: systemWide('codex') });

    await fake('claude', 'exit 0');
    await fake('codex', 'exit 0', bin);
    expect(parseProbeOutput(run(probeCommand()).stdout)).toEqual({ tmux: true, git: true, claude: true, codex: true });
  });

  it('opens a shell in the directory inside a named tmux session', async () => {
    await fakeTmux();
    const directory = path.join(root, 'work', 'project-1');
    const result = run(session('shell', directory));
    expect(result.status, result.stderr).toBe(0);
    expect(log('tmux.log')).toEqual([`cwd=${directory}`, 'arg=new-session', 'arg=-A', 'arg=-s', 'arg=studio-test-0123456789ab']);
  });

  it('stays in the home directory when no directory is given', async () => {
    await fakeTmux();
    expect(run(session('shell', null)).status).toBe(0);
    expect(log('tmux.log')[0]).toBe(`cwd=${root}`); // where this test started the shell, i.e. no cd happened
  });

  it('starts an agent with a configuration directory of its own', async () => {
    await fakeTmux();
    await fake('claude', 'exit 0');
    const result = run(session('claude', path.join(root, 'work')));
    expect(result.status, result.stderr).toBe(0);
    const config = path.join(home, '.agent-studio-remote', 'u0123456789ab', 'claude');
    expect(log('tmux.log')).toEqual([
      `cwd=${path.join(root, 'work')}`,
      'arg=new-session',
      'arg=-A',
      'arg=-s',
      'arg=studio-test-0123456789ab',
      'arg=env',
      `arg=CLAUDE_CONFIG_DIR=${config}`,
      `arg=${path.join(localBin, 'claude')}`,
    ]);
    expect(statSync(config).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(home, '.agent-studio-remote')).mode & 0o777).toBe(0o700);
    // The remote account's own agent configuration is not created or touched.
    expect(existsSync(path.join(home, '.claude'))).toBe(false);

    await fake('codex', 'exit 0');
    expect(run(session('codex', null)).status).toBe(0);
    expect(log('tmux.log').slice(-3)).toEqual(['arg=env', `arg=CODEX_HOME=${path.join(home, '.agent-studio-remote', 'u0123456789ab', 'codex')}`, `arg=${path.join(localBin, 'codex')}`]);
  });

  it('says so when the directory or the program is missing, and starts nothing', async () => {
    await fakeTmux();
    const noDirectory = run(session('shell', '/no/such/directory'));
    expect(noDirectory.status).toBe(66);
    expect(noDirectory.stderr).toContain('agent-studio: cannot open the directory /no/such/directory on this host');

    const noProgram = run(session('codex', null));
    expect(noProgram.status).toBe(127);
    expect(noProgram.stderr).toContain('agent-studio: codex is not installed on this host');
    expect(existsSync(path.join(home, 'tmux.log'))).toBe(false);
    expect(existsSync(path.join(home, '.agent-studio-remote'))).toBe(false);
  });

  it.skipIf(tmuxElsewhere)('runs directly, and says the session will not be kept, on a host without tmux', async () => {
    const loginShell = path.join(root, 'login-shell');
    await fake('login-shell', 'printf "shell-args=%s cwd=%s\\n" "$*" "$PWD" > "$HOME/shell.log"', root);
    const directory = path.join(root, 'work');
    const plain = run(session('shell', directory), { SHELL: loginShell });
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.stderr).toContain('tmux is not installed on this host, so this session ends when you disconnect');
    expect(log('shell.log')).toEqual([`shell-args=-l cwd=${directory}`]);

    await fake('claude', 'printf "config=%s\\n" "$CLAUDE_CONFIG_DIR" > "$HOME/claude.log"');
    expect(run(session('claude', null)).status).toBe(0);
    expect(log('claude.log')).toEqual([`config=${path.join(home, '.agent-studio-remote', 'u0123456789ab', 'claude')}`]);
  });

  it('never lets a directory be read as an option or as shell syntax', async () => {
    await fakeTmux();
    const hostile = HOSTILE_VALUES.filter((value) => value.length > 0 && value.length < 100);
    for (const directory of hostile) {
      // The request-level check refuses every one of them …
      expect(() => session('shell', directory), JSON.stringify(directory)).toThrow('not acceptable');
      // … and even if one got past it, the remote side would only fail to find such a directory.
      const result = run(remoteShellCommand(SESSION_SCRIPT, [directory, 'studio-test-0123456789ab', 'shell', 'u0123456789ab']));
      expect(result.status, JSON.stringify(directory)).toBe(66);
      expect(result.stderr).toContain('agent-studio: cannot open the directory');
      expect(existsSync(path.join(root, 'CANARY')), JSON.stringify(directory)).toBe(false);
      expect(existsSync(path.join(home, 'CANARY'))).toBe(false);
      expect(existsSync(path.join(home, 'tmux.log'))).toBe(false);
    }
    // A directory whose name merely looks like an option is still just a directory.
    await mkdir(path.join(root, '-P'));
    expect(run(remoteShellCommand(SESSION_SCRIPT, ['-P', 'studio-test-0123456789ab', 'shell', 'u0123456789ab'])).status).toBe(0);
    expect(log('tmux.log')[0]).toBe(`cwd=${path.join(root, '-P')}`);
  });

  it('refuses anything else that is not on the fixed list', () => {
    const ok = { program: 'shell' as const, directory: '/srv/work', sessionName: 'studio-shell-0123456789ab', userTag: 'u0123456789ab' };
    expect(sessionCommand(ok)).toContain("'/srv/work' 'studio-shell-0123456789ab' 'shell' 'u0123456789ab'");
    expect(sessionCommand({ ...ok, directory: null })).toContain("agent-studio '' 'studio-shell-0123456789ab' 'shell' 'u0123456789ab'");
    expect(() => sessionCommand({ ...ok, program: 'bash -c reboot' as never })).toThrow('cannot be started');
    expect(() => sessionCommand({ ...ok, program: 'vim' as never })).toThrow('cannot be started');
    for (const sessionName of ['', 'has space', 'semi;colon', 'dot.name', 'colon:name', '$(id)', 'x'.repeat(65)]) {
      expect(() => sessionCommand({ ...ok, sessionName })).toThrow('session name');
    }
    for (const userTag of ['', '../x', 'a b', 'A', 'x'.repeat(33)]) expect(() => sessionCommand({ ...ok, userTag })).toThrow('session name');
    for (const directory of ['relative', '~/work', '/srv/../etc', '/srv/my work', '/srv/-rf', '/x'.repeat(151)]) {
      expect(() => sessionCommand({ ...ok, directory })).toThrow('not acceptable');
    }
  });
});

describe('names derived on the server', () => {
  it('give the same user, program and directory the same tmux session every time', () => {
    const name = deriveSessionName('user-1', 'claude', '/srv/work');
    expect(name).toMatch(/^studio-claude-[0-9a-f]{12}$/);
    expect(deriveSessionName('user-1', 'claude', '/srv/work')).toBe(name);
    expect(deriveSessionName('user-2', 'claude', '/srv/work')).not.toBe(name);
    expect(deriveSessionName('user-1', 'codex', '/srv/work')).not.toBe(name);
    expect(deriveSessionName('user-1', 'claude', '/srv/other')).not.toBe(name);
    expect(deriveSessionName('user-1', 'shell', null)).toMatch(/^studio-shell-[0-9a-f]{12}$/);
    // Whatever the inputs look like, the result is a plain name.
    expect(deriveSessionName("x'; reboot #", 'shell', '$(id)')).toMatch(/^studio-shell-[0-9a-f]{12}$/);
  });

  it('separate users by a tag that says nothing about them', () => {
    expect(deriveUserTag('user-1')).toMatch(/^u[0-9a-f]{12}$/);
    expect(deriveUserTag('user-1')).toBe(deriveUserTag('user-1'));
    expect(deriveUserTag('user-1')).not.toBe(deriveUserTag('user-2'));
  });
});
