import { describe, expect, it } from 'vitest';
import {
  HOST_METHODS,
  HostRefusal,
  authorize,
  checkFetchTarget,
  chosenGrant,
  effectiveToolEffect,
  isHostMethod,
  isSensitiveProjectPath,
  projectInScope,
  type CallScope,
  type HostMethod,
} from './permissions.js';

const user = { id: 'u1', displayName: 'Alice', role: 'member' as const };
const scope = (extra: Partial<CallScope>): CallScope => ({ id: 's', kind: 'panel', readOnly: false, user, projectId: null, projectBound: false, ...extra });
const everything = new Set(['notifications', 'projects:read', 'network:api.example.com', 'network']);
const nothing = new Set<string>();

function outcome(method: HostMethod, callScope: CallScope, granted: ReadonlySet<string>): string {
  try {
    authorize(method, callScope, granted);
    return 'allowed';
  } catch (error) {
    if (error instanceof HostRefusal) return error.code;
    throw error;
  }
}

describe('authorize', () => {
  const panel = scope({ kind: 'panel' });
  const writeTool = scope({ kind: 'tool', projectBound: true });
  const readTool = scope({ kind: 'tool', readOnly: true, projectBound: true });
  const hook = scope({ kind: 'hook', user: null, projectBound: true });
  const start = scope({ kind: 'start', user: null, projectBound: true });

  // method, [panel, write tool, read tool, hook, start] with everything granted
  it.each<[HostMethod, string[]]>([
    ['host.storage.get', ['allowed', 'allowed', 'allowed', 'allowed', 'allowed']],
    ['host.storage.list', ['allowed', 'allowed', 'allowed', 'allowed', 'allowed']],
    ['host.storage.set', ['allowed', 'allowed', 'read_only_call', 'allowed', 'allowed']],
    ['host.storage.delete', ['allowed', 'allowed', 'read_only_call', 'allowed', 'allowed']],
    ['host.notify', ['allowed', 'allowed', 'read_only_call', 'no_user', 'no_user']],
    ['host.http.fetch', ['allowed', 'allowed', 'read_only_call', 'allowed', 'allowed']],
    ['host.projects.list', ['allowed', 'allowed', 'allowed', 'no_user', 'no_user']],
    ['host.files.read', ['allowed', 'allowed', 'allowed', 'no_user', 'no_user']],
  ])('%s with every permission granted', (method, expected) => {
    expect([panel, writeTool, readTool, hook, start].map((callScope) => outcome(method, callScope, everything))).toEqual(expected);
  });

  it('refuses what was not granted, whoever the call is for', () => {
    for (const callScope of [panel, writeTool, readTool, hook, start]) {
      expect(outcome('host.notify', callScope, nothing)).toBe('permission_denied');
      expect(outcome('host.projects.list', callScope, nothing)).toBe('permission_denied');
      expect(outcome('host.files.read', callScope, nothing)).toBe('permission_denied');
      // Storage is a plugin's own; it needs no permission.
      expect(outcome('host.storage.get', callScope, nothing)).toBe('allowed');
    }
  });

  it('does not take one permission for another', () => {
    expect(outcome('host.notify', panel, new Set(['projects:read', 'network']))).toBe('permission_denied');
    expect(outcome('host.projects.list', panel, new Set(['notifications', 'network:api.example.com']))).toBe('permission_denied');
    expect(outcome('host.files.read', panel, new Set(['projects:write', 'projects:read ', 'projects']))).toBe('permission_denied');
  });

  it('knows exactly the documented methods', () => {
    expect([...HOST_METHODS].sort()).toEqual([
      'host.files.read',
      'host.http.fetch',
      'host.notify',
      'host.projects.list',
      'host.storage.delete',
      'host.storage.get',
      'host.storage.list',
      'host.storage.set',
    ]);
    for (const name of ['host.exec', 'host.secrets.get', 'host.db.query', 'host.files.write', 'constructor', '__proto__', 'toString', '']) {
      expect(isHostMethod(name)).toBe(false);
    }
  });
});

describe('checkFetchTarget', () => {
  const granted = new Set(['network:api.example.com', 'network']);
  const refused = (url: string, grants: ReadonlySet<string> = granted): string => {
    try {
      checkFetchTarget(url, grants);
      return 'allowed';
    } catch (error) {
      return (error as HostRefusal).code;
    }
  };

  it('allows https to a granted host on the default port', () => {
    expect(checkFetchTarget('https://api.example.com/v1/items?x=1', granted).hostname).toBe('api.example.com');
    expect(refused('https://API.Example.COM/')).toBe('allowed');
    expect(refused('https://api.example.com./')).toBe('allowed');
    expect(refused('https://api.example.com:443/')).toBe('allowed');
  });

  it.each([
    ['http://api.example.com/', 'insecure_url'],
    ['ftp://api.example.com/', 'insecure_url'],
    ['file:///etc/passwd', 'insecure_url'],
    ['javascript:alert(1)', 'insecure_url'],
    ['not a url', 'invalid_url'],
    ['', 'invalid_url'],
    ['https://user:pw@api.example.com/', 'invalid_url'],
    ['https://api.example.com@evil.test/', 'invalid_url'],
    ['https://api.example.com:8443/', 'port_not_allowed'],
    ['https://api.example.com:80/', 'port_not_allowed'],
    ['https://other.example.com/', 'permission_denied'],
    ['https://example.com/', 'permission_denied'],
    ['https://sub.api.example.com/', 'permission_denied'],
    ['https://api.example.com.evil.test/', 'permission_denied'],
    ['https://evil.test/api.example.com', 'permission_denied'],
    ['https://evil.test/?h=api.example.com#api.example.com', 'permission_denied'],
    ['https://127.0.0.1/', 'permission_denied'],
    ['https://[::1]/', 'permission_denied'],
    ['https://localhost/', 'permission_denied'],
    ['https://169.254.169.254/', 'permission_denied'],
    ['https://2130706433/', 'permission_denied'],
  ])('refuses %s (%s)', (url, code) => {
    expect(refused(url)).toBe(code);
  });

  it('does not read the unrestricted network permission as a licence to fetch anything through the Studio', () => {
    expect(refused('https://api.example.com/', new Set(['network']))).toBe('permission_denied');
    expect(refused('https://api.example.com/', new Set())).toBe('permission_denied');
  });
});

describe('effectiveToolEffect', () => {
  it('keeps "write" as it is', () => {
    expect(effectiveToolEffect('write', [], true)).toBe('write');
  });

  it('honours "read" only for a plugin that cannot reach anyone', () => {
    expect(effectiveToolEffect('read', [], true)).toBe('read');
    expect(effectiveToolEffect('read', ['projects:read'], true)).toBe('read');
  });

  it.each([['network:api.example.com'], ['network'], ['notifications'], ['projects:read', 'network:x.example.com']])(
    'raises "read" to "write" when %s is granted',
    (...granted) => {
      expect(effectiveToolEffect('read', granted, true)).toBe('write');
    },
  );

  it('raises "read" to "write" on a machine that does not keep plugin processes off the network', () => {
    expect(effectiveToolEffect('read', [], false)).toBe('write');
  });
});

describe('chosenGrant', () => {
  const requested = ['notifications', 'network:a.example.com', 'projects:read'];

  it('accepts any subset, sorted and without repeats', () => {
    expect(chosenGrant(requested, [])).toEqual([]);
    expect(chosenGrant(requested, ['projects:read', 'notifications', 'projects:read'])).toEqual(['notifications', 'projects:read']);
    expect(chosenGrant(requested, requested)).toEqual([...requested].sort());
  });

  it('refuses to grant what the plugin did not ask for', () => {
    expect(() => chosenGrant(requested, ['network'])).toThrow(HostRefusal);
    expect(() => chosenGrant(requested, ['network:b.example.com'])).toThrow(/does not ask for/);
    expect(() => chosenGrant([], ['notifications'])).toThrow(HostRefusal);
  });
});

describe('projectInScope', () => {
  it('limits a bound call to its own project', () => {
    expect(projectInScope(scope({ projectBound: true, projectId: 'p1' }), 'p1')).toBe(true);
    expect(projectInScope(scope({ projectBound: true, projectId: 'p1' }), 'p2')).toBe(false);
    expect(projectInScope(scope({ projectBound: true, projectId: null }), 'p1')).toBe(false);
    expect(projectInScope(scope({ projectBound: false, projectId: null }), 'p1')).toBe(true);
  });
});

describe('isSensitiveProjectPath', () => {
  it.each(['.env', '.env.production', 'config/.env.local', '.npmrc', '.git/config', 'sub/.git/HEAD', '.ssh/id_rsa', 'keys/server.pem', 'deploy/id_ed25519', 'certs/site.key', 'credentials.json', 'secrets.yaml', '.aws/credentials', '.netrc', '.git-credentials', 'a/b/store.p12'])(
    'withholds %s',
    (file) => {
      expect(isSensitiveProjectPath(file)).toBe(true);
    },
  );

  it.each(['README.md', 'src/index.ts', 'docs/environment.md', 'src/keyboard.ts', '.github/workflows/ci.yml', '.gitignore', 'package.json', 'envelope.txt', 'src/secrets-manager.ts'])('hands out %s', (file) => {
    expect(isSensitiveProjectPath(file)).toBe(false);
  });
});
