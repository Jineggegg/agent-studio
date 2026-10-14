import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessSupervisor, Sandbox } from './process.js';
import { operatorPaths } from './studio.js';

describe('operatorPaths', () => {
  it('names the installer settings folder, an explicit settings file and the TLS key', () => {
    expect(operatorPaths({ tls: null }, { XDG_CONFIG_HOME: '/cfg' })).toEqual(['/cfg/agent-studio']);
    expect(operatorPaths({ tls: { certFile: '/tls/cert.pem', keyFile: '/tls/key.pem' } }, { XDG_CONFIG_HOME: '/cfg', AGENT_STUDIO_ENV_FILE: '/etc/studio.env' })).toEqual([
      '/cfg/agent-studio',
      '/etc/studio.env',
      '/tls/key.pem',
    ]);
    expect(operatorPaths({ tls: null }, {})).toEqual([path.join(os.homedir(), '.config', 'agent-studio')]);
  });
});

describe('agents cannot read the operator settings or the TLS key', () => {
  let base: string;
  let sandbox: Sandbox;
  let env: string;
  let key: string;
  const processes = new ProcessSupervisor();

  beforeAll(async () => {
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'studio-operator-paths-')));
    await mkdir(path.join(base, 'config', 'agent-studio'), { recursive: true });
    await mkdir(path.join(base, 'tls'));
    await mkdir(path.join(base, 'data'));
    env = path.join(base, 'config', 'agent-studio', 'env');
    key = path.join(base, 'tls', 'key.pem');
    await writeFile(env, 'AGENT_STUDIO_MASTER_KEY=operator-only-value\n');
    await writeFile(key, 'tls-private-key-value\n');
    const protectedPaths = operatorPaths({ tls: { certFile: path.join(base, 'tls', 'cert.pem'), keyFile: key } }, { XDG_CONFIG_HOME: path.join(base, 'config') });
    sandbox = await Sandbox.detect('auto', [path.join(base, 'data'), ...protectedPaths]);
  });

  afterAll(async () => {
    await processes.shutdown();
    await rm(base, { recursive: true, force: true });
  });

  it.each(['mask', 'confine'] as const)('in the %s profile', async (kind, context) => {
    if (sandbox.status.mode !== 'bwrap') return context.skip();
    const profile = kind === 'mask' ? { kind } : { kind, writable: [base], network: false };
    const command = sandbox.wrap('sh', ['-c', `cat "${env}" "${key}" 2>&1; echo done`], profile);
    const result = await processes.run(command.file, command.args, { timeoutMs: 10_000 });
    expect(result.stdout).toContain('done');
    expect(result.stdout).not.toContain('operator-only-value');
    expect(result.stdout).not.toContain('tls-private-key-value');
  });
});
