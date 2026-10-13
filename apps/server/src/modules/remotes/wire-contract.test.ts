import {
  REMOTE_DIRECTORY_MAX_LENGTH,
  createTerminalSessionRequestSchema,
  isSafeRemoteDirectory,
  remoteDirectorySchema,
  remoteHostIdSchema,
  renameTerminalSessionRequestSchema,
  terminalClientFrameSchema,
  terminalLauncherKeySchema,
  typeTextRequestSchema,
} from '@agent-studio/protocol';
import { describe, expect, it } from 'vitest';

/**
 * The request schemas are the first line of defence: what they refuse never
 * reaches the code that builds a command. These tests pin down that line.
 */

const PROJECT = '0123456789abcdefghjkmnpqrs';

describe('a remote directory as a client may name it', () => {
  it.each(['/', '/srv', '/srv/', '/srv/work/app-1', '/home/dev/code/my_project.v2', '/opt/build+cache/x@y', '/a/b/c/d/e/f/g', `/${'d'.repeat(REMOTE_DIRECTORY_MAX_LENGTH - 1)}`])(
    'accepts %s',
    (directory) => {
      expect(isSafeRemoteDirectory(directory)).toBe(true);
      expect(remoteDirectorySchema.safeParse(directory).success).toBe(true);
    },
  );

  it.each([
    ['empty', ''],
    ['relative', 'srv/work'],
    ['home-relative', '~/work'],
    ['a tilde user', '/~root'],
    ['a parent step', '/srv/../etc'],
    ['a trailing parent step', '/srv/..'],
    ['a dot segment', '/srv/./work'],
    ['an empty segment', '/srv//work'],
    ['two trailing slashes', '/srv//'],
    ['a space', '/srv/my work'],
    ['a tab', '/srv/my\twork'],
    ['a line feed', '/srv/work\n'],
    ['a carriage return', '/srv/work\r'],
    ['a NUL byte', '/srv/work\0'],
    ['a semicolon', '/srv;reboot'],
    ['an ampersand', '/srv&reboot'],
    ['a pipe', '/srv|reboot'],
    ['a redirection', '/srv>x'],
    ['a single quote', "/srv/it's"],
    ['a double quote', '/srv/"x"'],
    ['a backtick', '/srv/`id`'],
    ['a dollar sign', '/srv/$HOME'],
    ['command substitution', '/srv/$(id)'],
    ['a backslash', '/srv/a\\b'],
    ['a glob star', '/srv/*'],
    ['a question mark', '/srv/a?'],
    ['a bracket', '/srv/[a]'],
    ['a brace', '/srv/{a,b}'],
    ['an exclamation mark', '/srv/a!'],
    ['a hash', '/srv/#x'],
    ['a percent sign', '/srv/%h'],
    ['a colon', '/srv/a:b'],
    ['a comma', '/srv/a,b'],
    ['an equals sign', '/srv/a=b'],
    ['a segment that starts with a dash', '/srv/-rf'],
    ['an option', '-oProxyCommand=evil'],
    ['a double dash', '--'],
    ['an escape character', `/srv/${String.fromCharCode(27)}[2J`],
    ['a letter outside ASCII', '/srv/项目'],
    ['a full-width slash', '/srv／etc'],
    ['too many characters', `/${'d'.repeat(REMOTE_DIRECTORY_MAX_LENGTH)}`],
  ])('refuses %s', (_what, directory) => {
    expect(isSafeRemoteDirectory(directory)).toBe(false);
    expect(remoteDirectorySchema.safeParse(directory).success).toBe(false);
  });

  it('refuses anything that is not text', () => {
    for (const value of [undefined, null, 7, ['/srv'], { path: '/srv' }, true]) {
      expect(isSafeRemoteDirectory(value as never)).toBe(false);
      expect(remoteDirectorySchema.safeParse(value).success).toBe(false);
    }
  });
});

describe('the request to open a terminal', () => {
  const parse = (body: unknown) => createTerminalSessionRequestSchema.safeParse(body);

  it('has a project, a launcher key, a remote target, a size and a title, and nothing more', () => {
    expect(parse({ projectId: PROJECT }).data).toEqual({ projectId: PROJECT, cols: 80, rows: 24 });
    expect(parse({ projectId: PROJECT, launcher: 'remote-shell', remote: { hostId: 'build-box', directory: '/srv/work' }, cols: 120, rows: 40, title: ' build ' }).data).toEqual({
      projectId: PROJECT,
      launcher: 'remote-shell',
      remote: { hostId: 'build-box', directory: '/srv/work' },
      cols: 120,
      rows: 40,
      title: 'build',
    });
    expect(parse({ launcher: 'claude-login' }).success).toBe(true);
  });

  it.each([
    ['a command', { command: 'id' }],
    ['a program', { program: '/bin/sh' }],
    ['a shell', { shell: '/bin/bash' }],
    ['arguments', { args: ['-c', 'id'] }],
    ['a working directory', { cwd: '/etc' }],
    ['a path', { path: '/etc' }],
    ['an environment', { env: { LD_PRELOAD: 'x' } }],
    ['a user', { user: 'root' }],
    ['a host name next to the remote target', { hostname: 'evil.example' }],
    ['a host name inside the remote target', { remote: { hostId: 'build-box', hostname: 'evil.example' } }],
    ['a port inside the remote target', { remote: { hostId: 'build-box', port: 22 } }],
    ['SSH options inside the remote target', { remote: { hostId: 'build-box', options: ['-oProxyCommand=x'] } }],
    ['a remote target without a host', { remote: { directory: '/srv' } }],
    ['a host that is not an id', { remote: { hostId: 'evil.example' } }],
    ['a launcher that is a path', { launcher: '/bin/sh' }],
    ['a launcher with arguments', { launcher: 'claude-login --dangerous' }],
    ['a project that is not an id', { projectId: '../../etc' }],
    ['a width of zero', { cols: 0 }],
    ['a huge width', { cols: 100_000 }],
    ['a fractional height', { rows: 24.5 }],
    ['a title with a control character', { title: `a${String.fromCharCode(27)}[2Jb` }],
    ['an empty title', { title: '   ' }],
    ['a title that is too long', { title: 't'.repeat(81) }],
  ])('refuses %s', (_what, extra) => {
    expect(parse({ projectId: PROJECT, ...extra }).success).toBe(false);
  });
});

describe('the smaller contracts', () => {
  it('know what an id of a host and a key of a launcher look like', () => {
    for (const id of ['a', 'build-box', 'gpu-01', 'x'.repeat(32)]) expect(remoteHostIdSchema.safeParse(id).success, id).toBe(true);
    for (const id of ['', '-a', 'a-', 'A', 'a b', 'a.b', 'a_b', 'x'.repeat(33), 'root@host']) expect(remoteHostIdSchema.safeParse(id).success, id).toBe(false);
    for (const key of ['claude-login', 'remote-shell', 'ab', 'x1-y2']) expect(terminalLauncherKeySchema.safeParse(key).success, key).toBe(true);
    for (const key of ['', 'a', 'A-b', '1ab', '-ab', 'a b', 'a/b', 'a.b', 'x'.repeat(41)]) expect(terminalLauncherKeySchema.safeParse(key).success, key).toBe(false);
  });

  it('accept only the three client frames, with nothing extra in them', () => {
    const parse = (frame: unknown) => terminalClientFrameSchema.safeParse(frame).success;
    expect(parse({ type: 'attach', cols: 80, rows: 24 })).toBe(true);
    expect(parse({ type: 'attach', cols: 80, rows: 24, after: 0 })).toBe(true);
    expect(parse({ type: 'attach', cols: 80, rows: 24, after: null })).toBe(true);
    expect(parse({ type: 'resize', cols: 2, rows: 1 })).toBe(true);
    expect(parse({ type: 'ping' })).toBe(true);
    expect(parse({ type: 'ping', t: 12.5 })).toBe(true);
    for (const frame of [
      { type: 'attach', cols: 80 },
      { type: 'attach', cols: 80, rows: 24, after: -1 },
      { type: 'attach', cols: 80, rows: 24, after: 1.5 },
      { type: 'attach', cols: 80, rows: 24, command: 'id' },
      { type: 'resize', cols: 1, rows: 24 },
      { type: 'resize', cols: 80, rows: 0 },
      { type: 'resize', cols: '80', rows: 24 },
      { type: 'input', data: 'id\n' },
      { type: 'run', command: 'id' },
      { type: 'ping', t: 'now' },
      {},
      null,
      'attach',
    ]) {
      expect(parse(frame), JSON.stringify(frame)).toBe(false);
    }
  });

  it('bound a rename and typed text', () => {
    expect(renameTerminalSessionRequestSchema.safeParse({ title: 'dev server' }).success).toBe(true);
    expect(renameTerminalSessionRequestSchema.safeParse({ title: 'x', id: 'other' }).success).toBe(false);
    expect(typeTextRequestSchema.safeParse({ text: 'npm test' }).success).toBe(true);
    expect(typeTextRequestSchema.safeParse({ text: '' }).success).toBe(false);
    expect(typeTextRequestSchema.safeParse({ text: 'x'.repeat(4001) }).success).toBe(false);
    expect(typeTextRequestSchema.safeParse({ text: 'x', enter: true }).success).toBe(false);
  });
});
