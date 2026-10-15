import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { downloadTerminal, TERMINAL_PLATFORMS } from './release-download.mjs';

const body = Buffer.from('verified terminal archive');
const integrity = `sha512-${createHash('sha512').update(body).digest('base64')}`;
const entry = (platform = 'linux-arm64') => ({
  version: '1.1.0',
  resolved: `https://registry.npmjs.org/@lydell/node-pty-${platform}/-/node-pty-${platform}-1.1.0.tgz`,
  integrity,
});
let curl;
beforeEach(() => {
  curl = mock.method(childProcess, 'execFileSync', () => body);
  syncBuiltinESMExports();
});
afterEach(() => {
  mock.restoreAll();
  syncBuiltinESMExports();
});

test('downloads every supported platform from its approved URL with bounded, HTTPS-only curl', () => {
  for (const platform of TERMINAL_PLATFORMS) {
    assert.deepEqual(downloadTerminal(platform, entry(platform)), body);
    const [command, args, options] = curl.mock.calls.at(-1).arguments;
    assert.equal(command, 'curl');
    assert.equal(args[0], '--disable'); // Must be first to disable curlrc.
    for (const flag of ['--fail', '--silent', '--show-error', '--location', '--globoff']) assert.ok(args.includes(flag));
    for (const [flag, value] of [
      ['--max-redirs', '0'], ['--proto', '=https'], ['--proto-redir', '=https'],
      ['--connect-timeout', '15'], ['--max-time', '120'], ['--url', entry(platform).resolved],
    ]) assert.equal(args[args.indexOf(flag) + 1], value);
    assert.equal(options.maxBuffer, 64 * 1024 * 1024);
  }
});

test('rejects hostile or unexpected lockfile URLs before invoking curl', () => {
  const url = entry().resolved;
  for (const resolved of [
    'http://registry.npmjs.org/package.tgz', 'file:///etc/passwd',
    'https://example.invalid/package.tgz', 'https://127.0.0.1/package.tgz',
    url.replace('registry.npmjs.org', 'registry.npmjs.org.example.invalid'),
    url.replace('registry.npmjs.org', 'registry.npmjs.org@example.invalid'),
    url.replace('registry.npmjs.org', 'user:password@registry.npmjs.org'),
    url.replace('registry.npmjs.org', 'registry.npmjs.org:444'),
    `${url}?data=local-file`, `${url}#fragment`, `${url}\n`,
    url.replace('linux-arm64', 'linux-x64'),
    url.replace('/@lydell/', '/%2e%2e/'),
    '--config=/tmp/curlrc', '--data-binary=@/etc/passwd', undefined,
  ]) {
    assert.throws(() => downloadTerminal('linux-arm64', { ...entry(), resolved }), /approved npm package/);
  }
  assert.equal(curl.mock.callCount(), 0);
});

test('rejects missing entries, unknown platforms, version drift and weak or malformed integrity before download', () => {
  assert.throws(() => downloadTerminal('linux-arm64', undefined), /approved npm package/);
  assert.throws(() => downloadTerminal('../linux-arm64', entry()), /approved npm package/);
  assert.throws(() => downloadTerminal('linux-arm64', { ...entry(), version: '1.2.0' }), /approved npm package/);
  for (const invalid of [undefined, '', 'sha1-abc', 'md5-abc', `${integrity} extra`, integrity.slice(0, -1), 123]) {
    assert.throws(() => downloadTerminal('linux-arm64', { ...entry(), integrity: invalid }), /SHA-512/);
  }
  assert.equal(curl.mock.callCount(), 0);
});

test('does not return an archive when integrity fails', () => {
  curl.mock.mockImplementation(() => Buffer.from('tampered archive'));
  assert.throws(() => downloadTerminal('linux-arm64', entry()), /does not match the lockfile integrity/);
});

test('propagates curl failures (including rejected redirects) without returning an archive', () => {
  curl.mock.mockImplementation(() => { throw new Error('curl: (47) Maximum redirects followed'); });
  assert.throws(() => downloadTerminal('linux-arm64', entry()), /Maximum redirects/);
  assert.equal(curl.mock.callCount(), 1);
});

test('the repository lockfile agrees with the independently approved package URLs and versions', () => {
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  for (const platform of TERMINAL_PLATFORMS) {
    const pinned = lock.packages[`node_modules/@lydell/node-pty-${platform}`];
    assert.match(pinned.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
    assert.deepEqual(downloadTerminal(platform, { ...pinned, integrity }), body);
  }
});
