import { describe, expect, it } from 'vitest';
import type { Principal } from '../../kernel/principal.js';
import { BUILT_IN_LAUNCHERS, LauncherRegistry, type TerminalLauncher, programLauncher } from './launchers.js';
import { DEFAULT_TERMINAL_LIMITS, resolveLimits } from './limits.js';
import { type PtyAvailability, cachedPtyLoader, createPtyBackend, loadNativePty } from './pty.js';

const someone: Principal = {
  userId: 'u',
  username: 'owner',
  displayName: 'Owner',
  role: 'owner',
  via: 'session',
  credentialId: 'c',
  scopes: ['read', 'write', 'admin'],
  authenticatedAt: Date.now(),
};

describe('built-in launchers', () => {
  it('are exactly the sign-in commands of the supported agent CLIs', async () => {
    const plans = await Promise.all(
      BUILT_IN_LAUNCHERS.map(async (launcher) => ({
        key: launcher.key,
        kind: launcher.kind,
        projectOptional: launcher.projectOptional === true,
        remote: launcher.remote === true,
        plan: await launcher.plan({ user: someone, project: null, remote: null }),
      })),
    );
    expect(plans).toEqual([
      { key: 'claude-login', kind: 'agent-sign-in', projectOptional: true, remote: false, plan: { file: 'claude', args: ['auth', 'login'], title: 'Claude Code sign-in', sandbox: { kind: 'mask' } } },
      { key: 'codex-login', kind: 'agent-sign-in', projectOptional: true, remote: false, plan: { file: 'codex', args: ['login'], title: 'Codex sign-in', sandbox: { kind: 'mask' } } },
      {
        key: 'codex-login-device',
        kind: 'agent-sign-in',
        projectOptional: true,
        remote: false,
        plan: { file: 'codex', args: ['login', '--device-auth'], title: 'Codex sign-in with a device code', sandbox: { kind: 'mask' } },
      },
    ]);
  });

  it('say so when their program is not installed', () => {
    const [claude] = BUILT_IN_LAUNCHERS;
    expect(claude!.unavailableReason!({ PATH: '/nonexistent-directory' })).toBe('The claude command is not installed on this computer.');
    expect(claude!.unavailableReason!({})).toContain('not installed');
    expect(programLauncher({ key: 'sh-test', title: 'sh', kind: 'other', program: 'sh', args: [] }).unavailableReason!({ PATH: '/bin:/usr/bin' })).toBeNull();
  });
});

describe('the launcher registry', () => {
  const launcher = (key: string): TerminalLauncher => ({ key, title: key, kind: 'other', plan: () => ({ file: 'true', args: [] }) });

  it('starts with the built-ins and accepts more', () => {
    const registry = new LauncherRegistry();
    expect(registry.list().map((entry) => entry.key)).toEqual(['claude-login', 'codex-login', 'codex-login-device']);
    registry.register(launcher('my-tool'));
    expect(registry.get('my-tool')?.title).toBe('my-tool');
    expect(registry.get('absent')).toBeNull();
  });

  it('refuses a duplicate unless the caller asks to replace', () => {
    const registry = new LauncherRegistry([]);
    registry.register(launcher('my-tool'));
    expect(() => registry.register(launcher('my-tool'))).toThrow('already registered');
    const replacement = { ...launcher('my-tool'), title: 'replaced' };
    registry.register(replacement, { replace: true });
    expect(registry.get('my-tool')?.title).toBe('replaced');
    expect(registry.list()).toHaveLength(1);
  });

  it.each(['', 'A', 'Has Space', '-leading-dash', '9starts-with-digit', 'under_score', '../escape', 'x'.repeat(41), 'semi;colon'])('refuses the key %j', (key) => {
    expect(() => new LauncherRegistry([]).register(launcher(key))).toThrow('not a valid launcher key');
  });
});

describe('terminal limits', () => {
  it('have the documented defaults', () => {
    expect(resolveLimits()).toEqual(DEFAULT_TERMINAL_LIMITS);
    expect(DEFAULT_TERMINAL_LIMITS).toMatchObject({
      maxSessionsPerUser: 16,
      maxSessions: 32,
      maxClientsPerSession: 4,
      replayBufferBytes: 1024 * 1024,
      idleTimeoutMs: 30 * 60 * 1000,
      maxLifetimeMs: 7 * 24 * 60 * 60 * 1000,
      heartbeatMs: 30_000,
      maxInputFrameBytes: 64 * 1024,
    });
  });

  it('accept overrides and refuse nonsense', () => {
    expect(resolveLimits({ idleTimeoutMs: 50 }).idleTimeoutMs).toBe(50);
    expect(() => resolveLimits({ maxSessions: 0 })).toThrow('maxSessions');
    expect(() => resolveLimits({ idleTimeoutMs: Number.NaN })).toThrow('idleTimeoutMs');
    expect(() => resolveLimits({ clientBufferLowBytes: 10, clientBufferHighBytes: 5 })).toThrow('low < high');
    expect(() => resolveLimits({ clientBufferHighBytes: 100, clientBufferHardBytes: 50, clientBufferLowBytes: 1 })).toThrow('high <= hard');
  });
});

describe('the pseudo-terminal backend', () => {
  function fakeNative() {
    const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = [];
    return {
      calls,
      native: {
        spawn(file: string, args: string[], options: Record<string, unknown>) {
          calls.push({ file, args, options });
          return { pid: 4242, write() {}, resize() {}, pause() {}, resume() {}, onData: () => undefined, onExit: () => undefined };
        },
      },
    };
  }

  it('passes an explicit environment and asks for raw bytes', () => {
    const fake = fakeNative();
    const env = { PATH: '/usr/bin', TERM: 'xterm-256color' };
    const child = createPtyBackend(fake.native).spawn('/bin/sh', ['-l'], { cwd: '/tmp', env, cols: 90, rows: 30 });
    expect(child.pid).toBe(4242);
    expect(fake.calls).toEqual([{ file: '/bin/sh', args: ['-l'], options: { name: 'xterm-256color', cols: 90, rows: 30, cwd: '/tmp', env, encoding: null } }]);
    // A copy: the library must not be handed an object it could confuse with the server's own environment.
    expect(fake.calls[0]!.options.env).not.toBe(env);
    expect(fake.calls[0]!.options.env).not.toBe(process.env);
  });

  it("refuses the server's own settings, NUL bytes and an empty program", () => {
    const backend = createPtyBackend(fakeNative().native);
    const options = { cwd: '/tmp', env: { PATH: '/usr/bin' }, cols: 80, rows: 24 };
    expect(() => backend.spawn('/bin/sh', [], { ...options, env: { PATH: '/usr/bin', AGENT_STUDIO_MASTER_KEY: 'x' } })).toThrow('AGENT_STUDIO_MASTER_KEY');
    expect(() => backend.spawn('/bin/sh', ['a\0b'], options)).toThrow('not a valid process argument');
    expect(() => backend.spawn('/bin/s\0h', [], options)).toThrow('not a valid process argument');
    expect(() => backend.spawn('', [], options)).toThrow('not a valid process argument');
  });

  it("turns the library's exit report into an exit code or a signal", () => {
    let report: (event: { exitCode: number; signal?: number }) => void = () => {};
    const backend = createPtyBackend({
      spawn: () => ({ pid: 1, write() {}, resize() {}, pause() {}, resume() {}, onData: () => undefined, onExit: (listener) => (report = listener) }),
    });
    const seen: unknown[] = [];
    backend.spawn('/bin/sh', [], { cwd: '/', env: {}, cols: 80, rows: 24 }).onExit((exit) => seen.push(exit));
    report({ exitCode: 3, signal: 0 });
    report({ exitCode: 0, signal: 9 });
    report({ exitCode: 0 });
    expect(seen).toEqual([
      { exitCode: 3, signal: null },
      { exitCode: null, signal: 9 },
      { exitCode: 0, signal: null },
    ]);
  });

  it('loads once and remembers the answer, also when the answer is no', async () => {
    let loads = 0;
    const missing: PtyAvailability = { available: false, reason: 'not installed' };
    const load = cachedPtyLoader(() => {
      loads += 1;
      return Promise.resolve(missing);
    });
    expect(await load()).toBe(missing);
    expect(await load()).toBe(missing);
    expect(loads).toBe(1);
  });

  it('reports the real library as available, or says why not', async () => {
    const real = await loadNativePty();
    if (real.available) expect(typeof real.backend.spawn).toBe('function');
    else expect(real.reason.length).toBeGreaterThan(10);
  });
});
