import { readlinkSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ProcessSupervisor, Sandbox } from './process.js';

describe('isolated debug pipes', () => {
  it('keeps CDP pipes usable across a sandbox with the network namespace isolated', async (test) => {
    const supervisor = new ProcessSupervisor();
    const sandbox = await Sandbox.detect('auto', []);
    if (sandbox.status.mode !== 'bwrap') return test.skip();
    const wrapped = sandbox.wrap(
      '/usr/bin/python3',
      [
        '-c',
        'import os; data=os.read(3,64); os.write(4,data); print(os.readlink("/proc/self/ns/net"))',
      ],
      { kind: 'isolate', readable: [], writable: [], network: false },
    );
    expect(wrapped.args).toContain('--unshare-net');
    const child = supervisor.spawn(wrapped.file, wrapped.args, { debugPipe: true });
    let namespace = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      namespace += chunk.toString();
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const answer = new Promise<string>((resolve, reject) => {
      (child.stdio[4] as Duplex).once('data', (chunk: Buffer) => resolve(chunk.toString()));
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0) reject(new Error('Sandbox debug pipe failed'));
      });
    });
    (child.stdio[3] as Duplex).write('synthetic cdp message');
    expect(await answer).toBe('synthetic cdp message');
    await exited;
    expect(namespace.trim()).not.toBe(readlinkSync('/proc/self/ns/net'));
    await supervisor.shutdown();
  });
});
