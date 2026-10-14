import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseOrigin } from './config.js';
import { Database, KEPT_UPGRADE_SNAPSHOTS } from './database.js';
import { EventBus } from './events.js';
import { looksLikeApiPath } from './http.js';
import { SECRET_HINT, redactSecrets, secretHint } from './redact.js';
import { KeyRing, SECRETS_MIGRATIONS, SecretStore } from './secrets.js';
import { AttemptThrottle } from '../modules/auth/throttle.js';

describe('loadConfig', () => {
  it('has safe defaults', () => {
    const config = loadConfig({});
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(7420);
    expect(config.env).toBe('production');
    expect(config.publicOrigins).toEqual([]);
    expect(config.trustProxy).toBe(false);
  });

  it('ignores generic variable names that other services use', () => {
    const config = loadConfig({ PORT: '3002', NODE_ENV: 'development', DATABASE_PATH: '/srv/other/app.db', HOST: '0.0.0.0' });
    expect(config.port).toBe(7420);
    expect(config.env).toBe('production');
    expect(config.host).toBe('127.0.0.1');
    expect(config.dataDir).not.toContain('/srv/other');
  });

  it('normalises public origins and rejects ones with paths', () => {
    expect(loadConfig({ AGENT_STUDIO_PUBLIC_ORIGINS: 'https://studio.example.com/, http://100.100.1.2:7420' }).publicOrigins).toEqual([
      'https://studio.example.com',
      'http://100.100.1.2:7420',
    ]);
    expect(() => parseOrigin('https://studio.example.com/app')).toThrow(ConfigError);
    expect(() => parseOrigin('ftp://studio.example.com')).toThrow(ConfigError);
  });

  it.each([
    { AGENT_STUDIO_PORT: '70000' },
    { AGENT_STUDIO_PORT: 'abc' },
    { AGENT_STUDIO_SANDBOX: 'docker' },
    { AGENT_STUDIO_TLS_CERT: '/x/cert.pem' },
    { AGENT_STUDIO_MASTER_KEY: 'c2hvcnQ=' },
    { AGENT_STUDIO_SETUP_TOKEN: 'short' },
    { AGENT_STUDIO_CHILD_ENV_PASSTHROUGH: 'PATH,AGENT_STUDIO_MASTER_KEY' },
    { AGENT_STUDIO_TRUST_PROXY: 'maybe' },
  ])('rejects %j', (env) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });
});

describe('Database', () => {
  it('applies migrations once and in order', () => {
    const db = new Database(':memory:');
    const migrations = [
      { version: 1, name: 'one', sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)' },
      { version: 2, name: 'two', sql: 'ALTER TABLE t ADD COLUMN w TEXT' },
    ];
    expect(db.migrate('m', migrations)).toBe(2);
    expect(db.migrate('m', migrations)).toBe(0);
    db.run('INSERT INTO t (v, w) VALUES (?, ?)', 'a', 'b');
    expect(db.get<{ v: string; w: string }>('SELECT v, w FROM t')).toEqual({ v: 'a', w: 'b' });
    db.close();
  });

  describe('across versions', () => {
    let dir: string;
    const v1 = [{ version: 1, name: 'one', sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)' }];
    const v2 = [...v1, { version: 2, name: 'two', sql: 'ALTER TABLE t ADD COLUMN w TEXT' }];
    const part = (table: string) => [{ version: 1, name: 'one', sql: `CREATE TABLE ${table} (id INTEGER PRIMARY KEY)` }];
    const snapshots = () => (existsSync(path.join(dir, 'backups')) ? readdirSync(path.join(dir, 'backups')) : []);

    beforeEach(() => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'studio-db-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('copies an existing database aside, owner-only, before the first migration of an upgrade', () => {
      const file = path.join(dir, 'studio.db');
      const first = new Database(file);
      first.migrate('m', v1);
      expect(first.upgradeSnapshot).toBeNull(); // a new database has nothing to keep
      first.run('INSERT INTO t (v) VALUES (?)', 'kept');
      first.close();

      const upgraded = new Database(file);
      upgraded.migrate('m', v2);
      upgraded.migrate('other', part('other'));
      const copy = upgraded.upgradeSnapshot!;
      expect(snapshots()).toEqual([path.basename(copy)]); // one copy per run, before the first change
      expect(statSync(copy).mode & 0o777).toBe(0o600);
      upgraded.close();

      const before = new Database(copy);
      expect(before.get('SELECT v FROM t')).toEqual({ v: 'kept' });
      expect(before.all<{ name: string }>('PRAGMA table_info(t)').map((column) => column.name)).toEqual(['id', 'v']);
      before.close();
    });

    it('takes no copy when nothing is pending, and keeps only the last few', () => {
      const file = path.join(dir, 'studio.db');
      const first = new Database(file);
      first.migrate('m', v1);
      first.close();
      for (let round = 0; round < KEPT_UPGRADE_SNAPSHOTS + 2; round += 1) {
        const db = new Database(file);
        db.migrate('m', v1);
        expect(db.upgradeSnapshot).toBeNull();
        db.migrate(`new-part-${round}`, part(`p${round}`));
        expect(db.upgradeSnapshot).not.toBeNull();
        db.close();
      }
      expect(snapshots()).toHaveLength(KEPT_UPGRADE_SNAPSHOTS);
    });

    it('refuses a database a newer version has moved past, and changes nothing', () => {
      const file = path.join(dir, 'studio.db');
      const newer = new Database(file);
      newer.migrate('m', v2);
      newer.close();

      const older = new Database(file);
      expect(() => older.migrate('m', v1)).toThrow(/newer version.*schema 2.*knows 1.*Nothing was changed/s);
      expect(older.all<{ version: number }>("SELECT version FROM schema_migrations WHERE module = 'm'")).toHaveLength(2);
      expect(snapshots()).toEqual([]);
      older.close();
    });
  });

  it('refuses migration lists with gaps', () => {
    const db = new Database(':memory:');
    expect(() => db.migrate('m', [{ version: 2, name: 'x', sql: 'SELECT 1' }])).toThrow(/numbered/);
    db.close();
  });

  it('rolls a failed migration back completely', () => {
    const db = new Database(':memory:');
    expect(() =>
      db.migrate('m', [{ version: 1, name: 'bad', sql: 'CREATE TABLE ok (id INTEGER); CREATE TABLE broken (' }]),
    ).toThrow();
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'ok'")).toBeUndefined();
    db.close();
  });

  it('rolls back transactions, including nested ones', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (v TEXT)');
    expect(() =>
      db.transaction(() => {
        db.run('INSERT INTO t VALUES (?)', 'outer');
        throw new Error('nope');
      }),
    ).toThrow('nope');
    db.transaction(() => {
      db.run('INSERT INTO t VALUES (?)', 'kept');
      try {
        db.transaction(() => {
          db.run('INSERT INTO t VALUES (?)', 'inner');
          throw new Error('inner fails');
        });
      } catch {
        /* the outer transaction carries on */
      }
    });
    expect(db.all<{ v: string }>('SELECT v FROM t').map((row) => row.v)).toEqual(['kept']);
    db.close();
  });

  it('treats hostile strings as data', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (v TEXT)');
    const hostile = "'); DROP TABLE t; --";
    db.run('INSERT INTO t VALUES (?)', hostile);
    expect(db.get<{ v: string }>('SELECT v FROM t WHERE v = ?', hostile)).toEqual({ v: hostile });
    db.close();
  });
});

describe('EventBus', () => {
  it('delivers by type and by topic, and survives a failing handler', () => {
    const bus = new EventBus();
    const seen: string[] = [];
    const errors: unknown[] = [];
    bus.setErrorHandler((error) => errors.push(error));
    bus.on('a.happened', () => {
      throw new Error('handler bug');
    });
    bus.on('a.happened', (event) => seen.push(`type:${event.topic}`));
    const stop = bus.onTopic('t:1', (event) => seen.push(`topic:${event.type}`));
    bus.publish('t:1', 'a.happened', {});
    bus.publish('t:2', 'a.happened', {});
    stop();
    bus.publish('t:1', 'b.happened', {});
    expect(seen).toEqual(['type:t:1', 'topic:a.happened', 'type:t:2']);
    expect(errors).toHaveLength(2);
  });
});

// Put together at run time so that the source holds nothing in the exact shape secret scanners look for.
const FAKE_GOOGLE_KEY = ['AIza', 'SyA-test_0123456789abcdefghijklmnop'].join('');
const FAKE_GITLAB_TOKEN = ['glpat', '-test0123456789abcdefgh'].join('');

describe('redactSecrets', () => {
  it.each([
    ['key sk-abcdefghijklmnopqrstuvwxyz123456 used', 'sk-abcdefghijklmnopqrstuvwxyz123456'],
    ['Authorization: Bearer abcdef0123456789abcdef', 'abcdef0123456789abcdef'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['DB_PASSWORD=hunter2hunter2', 'hunter2hunter2'],
    ['"api_key": "abcd1234efgh5678"', 'abcd1234efgh5678'],
    ['-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----', 'MIIabc'],
    [`google key ${FAKE_GOOGLE_KEY} rejected`, FAKE_GOOGLE_KEY],
    [`gitlab ${FAKE_GITLAB_TOKEN}`, FAKE_GITLAB_TOKEN],
    ['fetch https://deploy:hunter2-test@git.example.com/repo.git failed', 'hunter2-test'],
    ['fetch https://deploy:p@ss-test@git.example.com/repo.git failed', 'ss-test'],
    ['GET https://api.example.com/v1/models?key=test-query-secret&page=2', 'test-query-secret'],
  ])('removes the secret from %j', (text, secret) => {
    const result = redactSecrets(text);
    expect(result).not.toContain(secret);
    expect(result).toContain('[redacted]');
  });

  it('leaves ordinary text alone', () => {
    const text = 'Ran 12 tests in src/token-parser.ts — all passed.';
    expect(redactSecrets(text)).toBe(text);
  });

  it('keeps no part of a secret in the clear: a description is the marker, and tails stored by an earlier version are overwritten', () => {
    const db = new Database(':memory:');
    // A database as an earlier version left it: the last four characters of the secret in `hint`.
    db.migrate('kernel.secrets', SECRETS_MIGRATIONS.slice(0, 1));
    db.run('INSERT INTO secrets (name, sealed, hint, updated_at) VALUES (?, ?, ?, ?)', 'provider:old', 'sealed-bytes', '…wxyz', 1);
    expect(db.migrate('kernel.secrets', SECRETS_MIGRATIONS)).toBe(1);
    expect(db.get<{ hint: string }>('SELECT hint FROM secrets WHERE name = ?', 'provider:old')!.hint).toBe(SECRET_HINT);

    const secrets = new SecretStore(db, new KeyRing(Buffer.alloc(32, 7)));
    const saved = secrets.put('provider:new', 'sk-live-abcdefghijklmnopQ_Zx');
    expect(saved.hint).toBe(SECRET_HINT);
    expect(secrets.describe('provider:new')).toEqual({ name: 'provider:new', hint: SECRET_HINT, updatedAt: saved.updatedAt });
    expect(secrets.reveal('provider:new')).toBe('sk-live-abcdefghijklmnopQ_Zx');
    // Even a row that somehow holds something else is described with the marker.
    db.run('UPDATE secrets SET hint = ? WHERE name = ?', '…Q_Zx', 'provider:new');
    expect(JSON.stringify(secrets.describe('provider:new'))).not.toContain('Q_Zx');
    expect(JSON.stringify(db.all('SELECT name, hint FROM secrets WHERE name = ?', 'provider:old'))).not.toContain('wxyz');
    db.close();
  });

  it('describes a stored secret with a fixed marker that holds no character of it', () => {
    const secret = 'sk-abcdefghijklmnop';
    expect(secretHint(secret)).toBe(SECRET_HINT);
    expect(secretHint('short')).toBe(SECRET_HINT);
    expect(secretHint()).toBe(SECRET_HINT);
    for (const character of new Set(secret)) expect(SECRET_HINT).not.toContain(character);
  });
});

describe('AttemptThrottle', () => {
  it('allows a few failures, then makes the caller wait longer each time', () => {
    const throttle = new AttemptThrottle({ freeAttempts: 3, baseDelayMs: 1000, maxDelayMs: 8000 });
    const t0 = 1_000_000;
    throttle.recordFailure('k', t0);
    throttle.recordFailure('k', t0);
    expect(throttle.retryAfter('k', t0)).toBe(0);
    throttle.recordFailure('k', t0);
    expect(throttle.retryAfter('k', t0)).toBe(1);
    expect(throttle.retryAfter('k', t0 + 1001)).toBe(0);
    throttle.recordFailure('k', t0 + 1001);
    expect(throttle.retryAfter('k', t0 + 1001)).toBe(2);
    for (let i = 0; i < 10; i += 1) throttle.recordFailure('k', t0 + 2000);
    expect(throttle.retryAfter('k', t0 + 2000)).toBe(8);
    expect(throttle.retryAfter('other', t0)).toBe(0);
  });

  it('forgives on success', () => {
    const throttle = new AttemptThrottle({ freeAttempts: 1, baseDelayMs: 60_000 });
    throttle.recordFailure('k');
    expect(throttle.retryAfter('k')).toBeGreaterThan(0);
    throttle.recordSuccess('k');
    expect(throttle.retryAfter('k')).toBe(0);
  });
});

describe('looksLikeApiPath', () => {
  it.each(['/api/users', '/api', '/API/users', '/%61pi/users', '/a%70i/x', '/%2561pi/users', '//api/users', '/api//users', '/%2Fapi/users', '/\\api/users', '/api/users?next=/home', '/%E0%A4%A/api'])(
    'treats %s as an API path',
    (url) => {
      expect(looksLikeApiPath(url)).toBe(true);
    },
  );

  it.each(['/', '/settings/account', '/assets/app-1a2b.js', '/apiary', '/projects/api/files', '/workbench?tab=api/'])('treats %s as a page or asset', (url) => {
    expect(looksLikeApiPath(url)).toBe(false);
  });
});
