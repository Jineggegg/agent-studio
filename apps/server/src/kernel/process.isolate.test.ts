import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessSupervisor, Sandbox } from './process.js';

/**
 * The `isolate` profile starts from an empty root instead of hiding things in
 * the real one, so anything it does not list is simply not there.
 */
describe('Sandbox: isolate profile', () => {
  let base: string;
  let dataDir: string;
  let code: string;
  let writable: string;
  let sandbox: Sandbox;
  const processes = new ProcessSupervisor();

  beforeAll(async () => {
    // Inside the home directory on purpose: /tmp would be absent from the sandbox either way.
    base = await realpath(await mkdtemp(path.join(os.homedir(), '.studio-isolate-test-')));
    dataDir = path.join(base, 'data');
    code = path.join(dataDir, 'plugins', 'one');
    writable = path.join(dataDir, 'plugin-data', 'one');
    await mkdir(code, { recursive: true });
    await mkdir(writable, { recursive: true });
    await writeFile(path.join(dataDir, 'master.key'), 'top-secret');
    await writeFile(path.join(base, 'neighbour.txt'), 'outside');
    await writeFile(path.join(code, 'hello.txt'), 'plugin code');
    sandbox = await Sandbox.detect('auto', [dataDir]);
  });

  afterAll(async () => {
    await processes.shutdown();
    await rm(base, { recursive: true, force: true });
  });

  const run = async (script: string, network = false) => {
    const command = sandbox.wrap('sh', ['-c', script], { kind: 'isolate', readable: [code], writable: [writable], network });
    expect(command.sandboxed).toBe(true);
    return processes.run(command.file, command.args, { cwd: writable, timeoutMs: 10_000 });
  };

  it('is a no-op when there is no sandbox', async () => {
    const off = await Sandbox.detect('off', [dataDir]);
    expect(off.wrap('echo', ['hi'], { kind: 'isolate', readable: [], writable: [], network: false })).toEqual({
      file: 'echo',
      args: ['hi'],
      sandboxed: false,
    });
  });

  it('shows the listed folders and nothing else of the data directory, the home directory or the host', async (context) => {
    if (sandbox.status.mode !== 'bwrap') return context.skip();
    const result = await run(
      [
        `cat "${code}/hello.txt"; echo`,
        `cat "${dataDir}/master.key" 2>/dev/null && echo leaked-key || echo no-key`,
        `cat "${base}/neighbour.txt" 2>/dev/null && echo leaked-neighbour || echo no-neighbour`,
        `ls -A "${os.homedir()}/.ssh" 2>/dev/null && echo saw-ssh || echo no-ssh`,
        `test -e /etc/passwd && echo saw-etc || echo no-etc`,
        `test -e /run && echo saw-run || echo no-run`,
        `ls "${dataDir}"`,
      ].join('; '),
    );
    expect(result.stdout).toContain('plugin code');
    expect(result.stdout).toContain('no-key');
    expect(result.stdout).not.toContain('top-secret');
    expect(result.stdout).toContain('no-neighbour');
    expect(result.stdout).toContain('no-ssh');
    expect(result.stdout).toContain('no-etc');
    expect(result.stdout).toContain('no-run');
    // Only the mount points of what was handed over exist under the data directory.
    expect(result.stdout.trim().split('\n').slice(-2)).toEqual(['plugin-data', 'plugins']);
  });

  it('lets the process write to its writable folder only — not its code, the root, /dev or /tmp', async (context) => {
    if (sandbox.status.mode !== 'bwrap') return context.skip();
    const result = await run(
      [
        `echo made > "${writable}/note.txt" && echo wrote-data`,
        `(echo x > "${code}/hello.txt") 2>/dev/null && echo wrote-code || echo blocked-code`,
        `(echo x > /escape.txt) 2>/dev/null && echo wrote-root || echo blocked-root`,
        `(echo x > /dev/shm/escape) 2>/dev/null && echo wrote-shm || echo blocked-shm`,
        `(echo x > /tmp/escape) 2>/dev/null && echo wrote-tmp || echo blocked-tmp`,
        `echo fine > /dev/null && echo dev-null-works`,
      ].join('; '),
    );
    expect(result.stdout).toContain('wrote-data');
    expect(result.stdout).toContain('blocked-code');
    expect(result.stdout).toContain('blocked-root');
    expect(result.stdout).toContain('blocked-shm');
    expect(result.stdout).toContain('blocked-tmp');
    expect(result.stdout).toContain('dev-null-works');
    expect(await readFile(path.join(writable, 'note.txt'), 'utf8')).toBe('made\n');
    expect(await readFile(path.join(code, 'hello.txt'), 'utf8')).toBe('plugin code');
  });

  it('sees no other process and no network interface unless the network is granted', async (context) => {
    if (sandbox.status.mode !== 'bwrap') return context.skip();
    const interfaces = (text: string) =>
      text
        .split('\n')
        .filter((line) => line.includes(':'))
        .map((line) => line.split(':')[0]!.trim());
    const cut = await run(`ls /proc | grep -c '^[0-9]' ; cat /proc/net/dev`);
    expect(Number(cut.stdout.split('\n')[0])).toBeLessThanOrEqual(4);
    expect(interfaces(cut.stdout.split('\n').slice(3).join('\n'))).toEqual(['lo']);
    expect(cut.stdout).not.toContain(String(process.pid) + '\n');

    const open = await run(`test -e /etc/resolv.conf && echo has-resolver; cat /proc/net/dev`, true);
    expect(open.stdout).toContain('has-resolver');
    expect(interfaces(open.stdout).length).toBeGreaterThanOrEqual(1);
  });

  it('refuses to hand over a folder that contains the protected data', async (context) => {
    if (sandbox.status.mode !== 'bwrap') return context.skip();
    const profile = (target: string) => ({ kind: 'isolate' as const, readable: [target], writable: [], network: false });
    expect(() => sandbox.wrap('true', [], profile(dataDir))).toThrow(/expose/);
    expect(() => sandbox.wrap('true', [], profile(base))).toThrow(/expose/);
    expect(() => sandbox.wrap('true', [], profile('/'))).toThrow(/expose/);
    expect(() => sandbox.wrap('true', [], { kind: 'isolate', readable: [], writable: [dataDir], network: false })).toThrow(/expose/);
    expect(() => sandbox.wrap('true', [], profile('relative/path'))).toThrow(/absolute/);
    expect(() => sandbox.wrap('true', [], profile(code))).not.toThrow();
  });
});
