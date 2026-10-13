import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessSupervisor, Sandbox, buildChildEnv } from './process.js';

describe('buildChildEnv', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/someone',
    AGENT_STUDIO_MASTER_KEY: 'do-not-leak',
    AGENT_STUDIO_DATA_DIR: '/srv/studio',
    DATABASE_URL: 'postgres://user:pw@db/prod',
    OPENAI_API_KEY: 'sk-from-the-server-environment',
    SSH_AUTH_SOCK: '/run/agent.sock',
  };

  it('passes the baseline and nothing else', () => {
    expect(buildChildEnv({ source })).toEqual({ PATH: '/usr/bin', HOME: '/home/someone' });
  });

  it('passes extra names only when the operator lists them', () => {
    expect(buildChildEnv({ source, passthrough: ['SSH_AUTH_SOCK'] })).toHaveProperty('SSH_AUTH_SOCK', '/run/agent.sock');
  });

  it("never passes the server's own settings, even when asked to", () => {
    const env = buildChildEnv({ source, passthrough: ['AGENT_STUDIO_MASTER_KEY'] });
    expect(env).not.toHaveProperty('AGENT_STUDIO_MASTER_KEY');
    expect(() => buildChildEnv({ source, extra: { AGENT_STUDIO_DATA_DIR: '/x' } })).toThrow();
  });

  it('adds what the caller sets on purpose', () => {
    expect(buildChildEnv({ source, extra: { TERM: 'xterm-256color', SKIPPED: undefined } })).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/someone',
      TERM: 'xterm-256color',
    });
  });
});

describe('ProcessSupervisor', () => {
  const processes = new ProcessSupervisor();

  it('passes arguments literally — nothing is interpreted by a shell', async () => {
    const hostile = '$(id); `id` && rm -rf / | cat > /tmp/x';
    const result = await processes.run('printf', ['%s', hostile]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(hostile);
  });

  it('reports a non-zero exit without throwing', async () => {
    const result = await processes.run('sh', ['-c', 'echo oops >&2; exit 3']);
    expect(result).toMatchObject({ code: 3, stderr: 'oops\n', timedOut: false });
  });

  it('rejects when the executable does not exist', async () => {
    await expect(processes.run('definitely-not-a-real-binary-xyz', [])).rejects.toThrow();
  });

  it('rejects NUL bytes in arguments', async () => {
    await expect(processes.run('echo', ['a\0b'])).rejects.toThrow(/not a valid process argument/);
  });

  it('stops a command that runs too long, including its children', async () => {
    const started = Date.now();
    const result = await processes.run('sh', ['-c', 'sleep 30 & sleep 30'], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('caps collected output', async () => {
    const result = await processes.run('sh', ['-c', 'head -c 100000 /dev/zero | tr "\\0" "a"'], { maxOutputBytes: 1000 });
    expect(result.stdout.length).toBe(1000);
    expect(result.truncated).toBe(true);
  });

  it('feeds standard input', async () => {
    const result = await processes.run('cat', [], { input: 'from stdin' });
    expect(result.stdout).toBe('from stdin');
  });

  it('does not hand the server environment to children', async () => {
    process.env.AGENT_STUDIO_TEST_SECRET = 'leak-me';
    try {
      const result = await processes.run('env', []);
      expect(result.stdout).not.toContain('AGENT_STUDIO_');
      expect(result.stdout).not.toContain('leak-me');
    } finally {
      delete process.env.AGENT_STUDIO_TEST_SECRET;
    }
  });

  it('stops everything on shutdown', async () => {
    const local = new ProcessSupervisor();
    local.spawn('sleep', ['60']);
    local.spawn('sleep', ['60']);
    expect(local.running).toBe(2);
    await local.shutdown(200);
    expect(local.running).toBe(0);
  });
});

describe('Sandbox', () => {
  let base: string;
  let protectedDir: string;
  let project: string;
  let sandbox: Sandbox;
  const processes = new ProcessSupervisor();

  beforeAll(async () => {
    base = await mkdtemp(path.join(os.homedir(), '.studio-sandbox-test-'));
    protectedDir = path.join(base, 'data');
    project = path.join(base, 'project');
    await import('node:fs/promises').then((fs) => Promise.all([fs.mkdir(protectedDir), fs.mkdir(project)]));
    await writeFile(path.join(protectedDir, 'master.key'), 'top-secret');
    await writeFile(path.join(base, 'neighbour.txt'), 'outside the project');
    sandbox = await Sandbox.detect('auto', [protectedDir]);
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('is a no-op when turned off', async () => {
    const off = await Sandbox.detect('off', [protectedDir]);
    expect(off.status.mode).toBe('none');
    expect(off.wrap('echo', ['hi'], { kind: 'mask' })).toEqual({ file: 'echo', args: ['hi'], sandboxed: false });
  });

  it('hides the protected directory from a masked process', async (context) => {
    if (sandbox.status.mode !== 'bwrap') return context.skip();
    const command = sandbox.wrap('sh', ['-c', `cat "${protectedDir}/master.key" 2>&1; ls -A "${protectedDir}" | wc -l`], { kind: 'mask' });
    expect(command.sandboxed).toBe(true);
    const result = await processes.run(command.file, command.args);
    expect(result.stdout).not.toContain('top-secret');
    expect(result.stdout.trim().endsWith('0')).toBe(true);
  });

  it('does not let a masked process reach the server through /proc', async (context) => {
    if (sandbox.status.mode !== 'bwrap') return context.skip();
    const command = sandbox.wrap('sh', ['-c', `cat /proc/${process.pid}/root${protectedDir}/master.key 2>&1 || true`], { kind: 'mask' });
    const result = await processes.run(command.file, command.args);
    expect(result.stdout + result.stderr).not.toContain('top-secret');
  });

  it('confines writes to the listed directories', async (context) => {
    if (sandbox.status.mode !== 'bwrap') return context.skip();
    const script = [
      `echo inside > "${project}/made-by-agent.txt" && echo wrote-project`,
      `(echo x > "${base}/neighbour.txt") 2>/dev/null && echo wrote-outside || echo blocked-outside`,
      `(echo x > "$HOME/.studio-sandbox-escape") 2>/dev/null && echo wrote-home || echo blocked-home`,
    ].join('; ');
    const command = sandbox.wrap('sh', ['-c', script], { kind: 'confine', writable: [project], network: false });
    const result = await processes.run(command.file, command.args, { env: processes.env() });
    expect(result.stdout).toContain('wrote-project');
    expect(result.stdout).toContain('blocked-outside');
    expect(result.stdout).toContain('blocked-home');
  });

  it('cuts the network off when asked', async (context) => {
    if (sandbox.status.mode !== 'bwrap') return context.skip();
    const command = sandbox.wrap('cat', ['/proc/net/dev'], { kind: 'confine', writable: [project], network: false });
    const result = await processes.run(command.file, command.args);
    const interfaces = result.stdout
      .split('\n')
      .slice(2)
      .map((line) => line.split(':')[0]!.trim())
      .filter(Boolean);
    expect(interfaces).toEqual(['lo']);
  });
});
