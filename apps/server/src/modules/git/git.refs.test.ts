import { describe, expect, it } from 'vitest';
import { isStudioError } from '../../kernel/errors.js';
import { assertBranchName, assertOid, assertRemoteName, assertRevision, githubRepositoryOf, parseRepositoryAddress, refProblem } from './git.refs.js';

/** Values no client-supplied name may ever be accepted as. Shared with the integration tests in spirit. */
export const HOSTILE_NAMES = [
  '-f',
  '--orphan=x',
  '--upload-pack=touch /tmp/pwned',
  '-o',
  '--output=/etc/passwd',
  '--exec=sh',
  '-c core.sshCommand=x',
  'HEAD;rm -rf ~',
  'bad name',
  'bad;name',
  'a..b',
  '../../outside',
  'topic.lock',
  'nested/part.lock/more',
  '$(touch pwned)',
  '`id`',
  'a|b',
  'a&b',
  'a>b',
  "quo'te",
  'dou"ble',
  'new\nline',
  'nul\0byte',
  'tab\tname',
  'back\\slash',
  'tilde~1',
  'caret^',
  'colon:name',
  'quest?ion',
  'star*',
  'brack[et',
  '@',
  'a@{1}',
  '/leading',
  'trailing/',
  'double//slash',
  'ends.',
  '.hidden',
  'a/.hidden',
  '',
  ' ',
  'x'.repeat(201),
];

function codeOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return isStudioError(error) ? `${error.status}:${error.code}` : 'not-a-studio-error';
  }
}

describe('branch and revision names', () => {
  it.each(HOSTILE_NAMES)('refuses %j as a branch, as a revision and as a remote', (name) => {
    expect(refProblem(name)).not.toBeNull();
    expect(codeOf(() => assertBranchName(name))).toBe('400:git_invalid_ref');
    expect(codeOf(() => assertRevision(name))).toBe('400:git_invalid_ref');
    expect(codeOf(() => assertRemoteName(name))).toBe('400:git_invalid_remote');
  });

  it.each(['main', 'feature/login-form', 'release-1.2.x', 'user/топик', '功能/登录', 'v1.0+build.5', 'fix_42', 'a@b', 'A=B'])('accepts %j', (name) => {
    expect(refProblem(name)).toBeNull();
    expect(assertBranchName(name)).toBe(name);
    expect(assertRevision(name)).toBe(name);
  });

  it.each(['HEAD', 'refs/heads/main', 'refs', 'FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD'])('keeps %j from becoming a branch name', (name) => {
    expect(codeOf(() => assertBranchName(name))).toBe('400:git_invalid_ref');
  });

  it('lets HEAD, tags, remote branches and commit ids name a revision', () => {
    for (const name of ['HEAD', 'origin/main', 'v2.0.0', '3bba0391ac390bed79688cdae72b3e8bd82f11fc', 'refs/heads/main']) {
      expect(assertRevision(name)).toBe(name);
    }
  });

  it.each(['HEAD~1', 'HEAD^', 'main@{upstream}', ':/fix', 'a..b', 'a...b', 'main:path', '^main'])('does not accept the revision expression %j', (expression) => {
    expect(codeOf(() => assertRevision(expression))).toBe('400:git_invalid_ref');
  });

  it('validates remote names and commit ids', () => {
    expect(assertRemoteName('origin')).toBe('origin');
    expect(assertRemoteName('up-stream_2.x')).toBe('up-stream_2.x');
    expect(codeOf(() => assertRemoteName('or/igin'))).toBe('400:git_invalid_remote');
    expect(assertOid('abc123f')).toBe('abc123f');
    for (const bad of ['', 'xyz', 'ABCDEF1', '-abc123', 'abc', 'a'.repeat(65), 'abc123f;ls']) {
      expect(codeOf(() => assertOid(bad)), bad).toBe('400:git_invalid_ref');
    }
  });
});

describe('repository addresses', () => {
  it.each([
    ['https://github.com/octo/demo.git', 'https', 'github.com', 'demo'],
    ['https://git.example.org:8443/team/sub/project', 'https', 'git.example.org', 'project'],
    ['ssh://git@example.org/team/project.git', 'ssh', 'example.org', 'project'],
    ['ssh://example.org:2222/srv/git/project.git', 'ssh', 'example.org', 'project'],
    ['git@github.com:octo/demo.git', 'ssh', 'github.com', 'demo'],
    ['deploy_user@build-host.internal:repos/thing', 'ssh', 'build-host.internal', 'thing'],
    ['  https://github.com/octo/demo  ', 'https', 'github.com', 'demo'],
  ])('accepts %s', (raw, transport, host, name) => {
    expect(parseRepositoryAddress(raw)).toMatchObject({ transport, host, name });
  });

  it.each([
    'ext::sh -c touch% /tmp/pwned',
    'ext::ssh example.org',
    'file:///etc',
    'file://localhost/srv/repo.git',
    '/srv/git/repo.git',
    './relative/repo',
    '../outside',
    'C:\\repos\\thing',
    'git://example.org/repo.git',
    'http://example.org/repo.git',
    'ftp://example.org/repo.git',
    'fd::17',
    'transport::address',
    '--upload-pack=touch /tmp/pwned',
    '-oProxyCommand=touch /tmp/pwned',
    'ssh://-oProxyCommand=touch/x',
    'git@-oProxyCommand=x:repo',
    '-u@host:repo',
    'git@host:-repo',
    'git@host:path/--upload-pack=x',
    'https://github.com/octo/demo.git?x=1',
    'https://github.com/octo/demo.git#frag',
    'https://github.com/octo/de mo.git',
    'https://github.com/octo/demo.git\n--upload-pack=x',
    'https://github.com/',
    'https://',
    'host:path',
    'github.com/octo/demo',
    '',
    'x'.repeat(501),
  ])('refuses %j', (raw) => {
    expect(codeOf(() => parseRepositoryAddress(raw))).toBe('400:invalid_repository_url');
  });

  it.each([
    'https://user:hunter2secret@github.com/octo/demo.git',
    'https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/octo/demo.git',
    'https://x-access-token:s3cr3t-value@github.com/octo/demo.git',
    'ssh://git:hunter2secret@example.org/repo.git',
  ])('refuses an address with credentials and does not repeat them: %s', (raw) => {
    try {
      parseRepositoryAddress(raw);
      expect.unreachable();
    } catch (error) {
      expect(isStudioError(error) && error.code).toBe('invalid_repository_url');
      const text = JSON.stringify(error) + (error as Error).message;
      expect(text).not.toContain('hunter2secret');
      expect(text).not.toContain('ghp_');
      expect(text).not.toContain('s3cr3t-value');
    }
  });

  it('recognises github.com repositories from any remote form, and nothing else', () => {
    for (const url of [
      'https://github.com/octo/demo.git',
      'https://github.com/octo/demo',
      'https://token@github.com/octo/demo.git',
      'git@github.com:octo/demo.git',
      'ssh://git@github.com/octo/demo.git',
      'ssh://git@github.com:22/octo/demo',
    ]) {
      expect(githubRepositoryOf(url), url).toEqual({ owner: 'octo', repo: 'demo' });
    }
    for (const url of [
      'https://gitlab.com/octo/demo.git',
      'https://github.com.evil.example/octo/demo.git',
      'https://evil.example/github.com/octo/demo',
      'git@github.com:octo/demo/extra',
      'https://github.com/-bad/demo',
      'https://github.com/octo/..',
      '/srv/git/demo.git',
      '',
    ]) {
      expect(githubRepositoryOf(url), url).toBeNull();
    }
  });
});
