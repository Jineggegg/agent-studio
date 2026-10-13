import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FALLBACK_SHELL, type ShellProbe, chooseLoginShell, findExecutable, isExecutableFile, parseEtcShells, probeHostShell } from './login-shell.js';

function probe(overrides: Partial<ShellProbe> & { executables?: string[] }): ShellProbe {
  const executables = new Set(overrides.executables ?? ['/bin/bash', '/usr/bin/bash', '/bin/zsh', '/usr/bin/fish', '/bin/sh', '/usr/sbin/nologin', '/bin/false']);
  return {
    accountShell: null,
    environmentShell: undefined,
    etcShells: '# valid login shells\n/bin/sh\n/bin/bash\n/usr/bin/bash\n/bin/zsh\n',
    isExecutableFile: (file) => executables.has(file),
    realPath: (file) => file.replace(/^\/bin\//, '/usr/bin/'),
    ...overrides,
  };
}

describe('choosing the login shell', () => {
  it('prefers the account database, then the environment, then /bin/sh', () => {
    expect(chooseLoginShell(probe({ accountShell: '/bin/zsh', environmentShell: '/bin/bash' }))).toEqual({ file: '/bin/zsh', source: 'account' });
    expect(chooseLoginShell(probe({ accountShell: null, environmentShell: '/bin/bash' }))).toEqual({ file: '/bin/bash', source: 'environment' });
    expect(chooseLoginShell(probe({}))).toEqual({ file: FALLBACK_SHELL, source: 'fallback' });
  });

  it.each([
    ['a relative path', 'bash'],
    ['a path with a parent step', '/bin/../bin/bash'],
    ['a path that is not normalised', '/bin//bash'],
    ['a path with a NUL byte', '/bin/bash\0'],
    ['an empty string', ''],
    ['a file that does not exist or is not executable', '/opt/missing/shell'],
    ['a shell that /etc/shells does not list', '/usr/bin/fish'],
    ['the account that may not log in', '/usr/sbin/nologin'],
    ['/bin/false', '/bin/false'],
    ['an option instead of a path', '-c'],
  ])('rejects %s and moves on', (_what, candidate) => {
    expect(chooseLoginShell(probe({ accountShell: candidate, environmentShell: '/bin/bash' }))).toEqual({ file: '/bin/bash', source: 'environment' });
    expect(chooseLoginShell(probe({ accountShell: candidate, environmentShell: candidate }))).toEqual({ file: FALLBACK_SHELL, source: 'fallback' });
  });

  it('accepts either spelling of a shell that /etc/shells lists through a link', () => {
    const merged = probe({ etcShells: '/usr/bin/zsh\n', accountShell: '/bin/zsh' });
    expect(chooseLoginShell(merged)).toEqual({ file: '/bin/zsh', source: 'account' });
  });

  it('does without /etc/shells where that file does not exist', () => {
    expect(chooseLoginShell(probe({ etcShells: null, accountShell: '/usr/bin/fish' }))).toEqual({ file: '/usr/bin/fish', source: 'account' });
    // The other rules still apply.
    expect(chooseLoginShell(probe({ etcShells: null, accountShell: '/usr/sbin/nologin' })).source).toBe('fallback');
    expect(chooseLoginShell(probe({ etcShells: null, accountShell: 'fish' })).source).toBe('fallback');
  });

  it('reads /etc/shells the way the system does', () => {
    expect(parseEtcShells('# comment\n/bin/sh\n  /bin/bash  # the usual\n\nrelative/shell\n/usr/bin/tmux\n')).toEqual(['/bin/sh', '/bin/bash', '/usr/bin/tmux']);
  });

  it('finds a real shell on this machine', () => {
    const chosen = chooseLoginShell(probeHostShell(process.env.SHELL));
    expect(path.isAbsolute(chosen.file)).toBe(true);
    expect(isExecutableFile(chosen.file)).toBe(true);
  });
});

describe('finding a program on a PATH', () => {
  let root: string;
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-which-'));
    await mkdir(path.join(root, 'first'));
    await mkdir(path.join(root, 'second'));
    await mkdir(path.join(root, 'second', 'folder'));
    await writeFile(path.join(root, 'first', 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(path.join(root, 'second', 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(path.join(root, 'second', 'other'), '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(path.join(root, 'second', 'plain'), 'not a program\n', { mode: 0o644 });
    await chmod(path.join(root, 'second', 'plain'), 0o644);
    await symlink(path.join(root, 'second', 'other'), path.join(root, 'first', 'linked'));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('takes the first match, like a shell would', () => {
    const searchPath = [path.join(root, 'first'), path.join(root, 'second')].join(path.delimiter);
    expect(findExecutable('tool', searchPath)).toBe(path.join(root, 'first', 'tool'));
    expect(findExecutable('other', searchPath)).toBe(path.join(root, 'second', 'other'));
    expect(findExecutable('linked', searchPath)).toBe(path.join(root, 'first', 'linked'));
  });

  it('skips files that cannot be run, folders, and missing names', () => {
    const searchPath = path.join(root, 'second');
    expect(findExecutable('plain', searchPath)).toBeNull();
    expect(findExecutable('folder', searchPath)).toBeNull();
    expect(findExecutable('absent', searchPath)).toBeNull();
    expect(findExecutable('tool', undefined)).toBeNull();
    expect(findExecutable('', searchPath)).toBeNull();
    expect(findExecutable('to\0ol', searchPath)).toBeNull();
  });

  it('ignores relative PATH entries, so the starting directory never decides what runs', () => {
    expect(findExecutable('tool', ['.', '', 'first', path.join(root, 'second')].join(path.delimiter))).toBe(path.join(root, 'second', 'tool'));
    expect(findExecutable('tool', '.')).toBeNull();
  });

  it('accepts a path only when it is absolute and executable', () => {
    expect(findExecutable(path.join(root, 'first', 'tool'), '')).toBe(path.join(root, 'first', 'tool'));
    expect(findExecutable('first/tool', root)).toBeNull();
    expect(findExecutable('./tool', path.join(root, 'first'))).toBeNull();
    expect(findExecutable(path.join(root, 'second', 'plain'), '')).toBeNull();
  });
});
