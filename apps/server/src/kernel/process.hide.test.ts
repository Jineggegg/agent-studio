import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessSupervisor, Sandbox, credentialPaths } from './process.js';

const NO_BWRAP = 'SKIPPED: bubblewrap is not usable on this machine, so hiding paths in the mask profile could not be tested here.';

describe('credentialPaths', () => {
  it('lists the places in a home directory that hold credentials, as absolute paths', () => {
    const paths = credentialPaths('/home/someone');
    expect(paths).toEqual(expect.arrayContaining(['/home/someone/.ssh', '/home/someone/.gnupg', '/home/someone/.aws', '/home/someone/.config/gh', '/home/someone/.netrc', '/home/someone/.git-credentials', '/home/someone/.claude', '/home/someone/.claude.json', '/home/someone/.codex']));
    expect(paths.every((entry) => entry.startsWith('/home/someone/'))).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

/**
 * The `mask` profile shows the machine as the user sees it, minus the Studio's
 * own data. `hide` takes more away for one process — under real bubblewrap,
 * because what matters is what a process inside can actually read.
 */
describe('Sandbox: hide in the mask profile', () => {
  let base: string;
  let dataDir: string;
  let home: string;
  let sandbox: Sandbox;
  const processes = new ProcessSupervisor();

  beforeAll(async () => {
    base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'agent-studio-hide-test-')));
    dataDir = path.join(base, 'data');
    home = path.join(base, 'home');
    await mkdir(path.join(dataDir, 'attachments'), { recursive: true });
    await mkdir(path.join(home, '.ssh'), { recursive: true });
    await mkdir(path.join(home, 'elsewhere'), { recursive: true });
    await mkdir(path.join(home, 'work'), { recursive: true });
    await writeFile(path.join(dataDir, 'studio.db'), 'the database');
    await writeFile(path.join(dataDir, 'attachments', 'picture.png'), 'an attachment');
    await writeFile(path.join(home, '.ssh', 'id_ed25519'), 'a private key');
    await writeFile(path.join(home, '.ssh', 'known_hosts'), 'hosts');
    await writeFile(path.join(home, 'config.toml'), 'approval_policy = "never"\n');
    await writeFile(path.join(home, 'elsewhere', 'token'), 'a token');
    await symlink(path.join(home, 'elsewhere'), path.join(home, 'linked'));
    await symlink(path.join(home, 'config.toml'), path.join(home, 'linked-config.toml'));
    await writeFile(path.join(home, 'work', 'notes.txt'), 'ordinary file');
    sandbox = await Sandbox.detect('auto', [dataDir]);
  });

  afterAll(async () => {
    await processes.shutdown();
    await rm(base, { recursive: true, force: true });
  });

  /** Runs a shell script inside the mask profile and returns what it printed. */
  const inside = async (script: string, profile: { hide?: string[]; expose?: string[] }, box: Sandbox = sandbox): Promise<string> => {
    const command = box.wrap('sh', ['-c', script], { kind: 'mask', ...profile });
    expect(command.sandboxed).toBe(true);
    const result = await processes.run(command.file, command.args, { cwd: path.join(home, 'work'), timeoutMs: 15_000 });
    expect(result.stderr).toBe('');
    return result.stdout;
  };

  it('is a no-op without a sandbox, whatever is listed', async () => {
    const off = await Sandbox.detect('off', [dataDir]);
    expect(off.wrap('echo', ['hi'], { kind: 'mask', hide: [path.join(home, '.ssh')] })).toEqual({ file: 'echo', args: ['hi'], sandboxed: false });
  });

  it('makes a hidden directory empty and a hidden file an empty, read-only regular file', async (context) => {
    if (sandbox.status.mode !== 'bwrap') return context.skip(NO_BWRAP);
    const ssh = path.join(home, '.ssh');
    const config = path.join(home, 'config.toml');
    const out = await inside(
      [
        `echo "ssh=[$(ls -A "${ssh}")]"`,
        `cat "${ssh}/id_ed25519" 2>/dev/null && echo leaked-key || echo no-key`,
        `echo "config=[$(cat "${config}")] size=$(stat -c %s "${config}") type=$(stat -c %F "${config}")"`,
        `(echo changed > "${config}") 2>/dev/null && echo wrote-config || echo config-read-only`,
        `cat "${home}/work/notes.txt"; echo`,
        `cat "${dataDir}/studio.db" 2>/dev/null && echo leaked-db || echo no-db`,
      ].join('; '),
      { hide: [ssh, config] },
    );
    expect(out.split('\n').filter(Boolean)).toEqual(['ssh=[]', 'no-key', 'config=[] size=0 type=regular empty file', 'config-read-only', 'ordinary file', 'no-db']);
    // Nothing happened to the real files.
    expect(await readFile(path.join(ssh, 'id_ed25519'), 'utf8')).toBe('a private key');
    expect(await readFile(config, 'utf8')).toBe('approval_policy = "never"\n');
  });

  it('leaves everything visible when nothing is listed', async (context) => {
    if (sandbox.status.mode !== 'bwrap') return context.skip(NO_BWRAP);
    const out = await inside(`cat "${home}/.ssh/id_ed25519"; echo; cat "${home}/config.toml"`, {});
    expect(out).toBe('a private key\napproval_policy = "never"\n');
  });

  it('skips what does not exist, and creates nothing in its place', async (context) => {
    if (sandbox.status.mode !== 'bwrap') return context.skip(NO_BWRAP);
    const missingDir = path.join(home, '.aws');
    const missingFile = path.join(home, '.netrc');
    const command = sandbox.wrap('true', [], { kind: 'mask', hide: [missingDir, missingFile] });
    expect(command.args.join(' ')).not.toContain('.aws');
    expect(command.args.join(' ')).not.toContain('.netrc');
    const out = await inside(`ls -A "${home}" | sort | tr '\\n' ' '`, { hide: [missingDir, missingFile] });
    expect(out.trim().split(' ')).toEqual(['.ssh', 'config.toml', 'elsewhere', 'linked', 'linked-config.toml', 'work']);
    expect(existsSync(missingDir)).toBe(false);
    expect(existsSync(missingFile)).toBe(false);
  });

  it('applies expose after hide: a path inside a hidden directory can be let back in, read-only', async (context) => {
    if (sandbox.status.mode !== 'bwrap') return context.skip(NO_BWRAP);
    const ssh = path.join(home, '.ssh');
    const known = path.join(ssh, 'known_hosts');
    const attachment = path.join(dataDir, 'attachments', 'picture.png');
    const out = await inside(
      [`echo "ssh=[$(ls -A "${ssh}")]"`, `cat "${known}"; echo`, `(echo x >> "${known}") 2>/dev/null && echo wrote || echo read-only`, `cat "${attachment}"; echo`, `echo "data=[$(ls -A "${dataDir}")]"`].join('; '),
      { hide: [ssh], expose: [known, attachment] },
    );
    expect(out.split('\n').filter(Boolean)).toEqual(['ssh=[known_hosts]', 'hosts', 'read-only', 'an attachment', 'data=[attachments]']);
  });

  it('follows a symbolic link, so the real place is hidden under every name', async (context) => {
    if (sandbox.status.mode !== 'bwrap') return context.skip(NO_BWRAP);
    const out = await inside(
      [`echo "link=[$(ls -A "${home}/linked")]"`, `echo "real=[$(ls -A "${home}/elsewhere")]"`, `echo "file=[$(cat "${home}/linked-config.toml")]"`, `echo "target=[$(cat "${home}/config.toml")]"`].join('; '),
      { hide: [path.join(home, 'linked'), path.join(home, 'linked-config.toml')] },
    );
    expect(out.split('\n').filter(Boolean)).toEqual(['link=[]', 'real=[]', 'file=[]', 'target=[]']);
  });

  it('keeps the empty stand-in file inside the protected directory, where no sandboxed process can reach it', async (context) => {
    if (sandbox.status.mode !== 'bwrap') return context.skip(NO_BWRAP);
    const config = path.join(home, 'config.toml');
    const command = sandbox.wrap('true', [], { kind: 'mask', hide: [config] });
    const standIn = command.args[command.args.indexOf(config) - 1]!;
    expect(standIn).toBe(path.join(dataDir, 'sandbox', 'empty'));
    expect((await stat(standIn)).size).toBe(0);
    // From inside — with or without `hide` — the stand-in is not there to be written to.
    const out = await inside(`(echo 'approval_policy = "never"' > "${standIn}") 2>/dev/null && echo wrote || echo unreachable; ls -A "${dataDir}" | wc -l`, {});
    expect(out.split('\n').filter(Boolean).map((line) => line.trim())).toEqual(['unreachable', '0']);
    expect((await stat(standIn)).size).toBe(0);

    // Should it ever hold something, it is replaced before it is used again.
    await rm(standIn, { force: true });
    await writeFile(standIn, 'not empty any more');
    sandbox.wrap('true', [], { kind: 'mask', hide: [config] });
    expect((await stat(standIn)).size).toBe(0);
  });

  it('works with nothing protected: the stand-in then lives in a folder this process cannot see', async (context) => {
    const bare = await Sandbox.detect('auto', []);
    if (bare.status.mode !== 'bwrap') return context.skip(NO_BWRAP);
    const config = path.join(home, 'config.toml');
    const command = bare.wrap('true', [], { kind: 'mask', hide: [config] });
    const standIn = command.args[command.args.indexOf(config) - 1]!;
    const folder = path.dirname(standIn);
    try {
      expect(folder.startsWith(os.tmpdir())).toBe(true);
      const out = await inside(`echo "config=[$(cat "${config}")]"; echo "folder=[$(ls -A "${folder}")]"`, { hide: [config] }, bare);
      expect(out.split('\n').filter(Boolean)).toEqual(['config=[]', 'folder=[]']);
      expect(await readdir(folder)).toEqual(['empty']);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('refuses a relative path', () => {
    if (sandbox.status.mode !== 'bwrap') return;
    expect(() => sandbox.wrap('true', [], { kind: 'mask', hide: ['.ssh'] })).toThrow(/absolute/);
  });
});
