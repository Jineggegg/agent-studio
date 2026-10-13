import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseOrigin } from './config.js';
import { Database } from './database.js';
import { EventBus } from './events.js';
import { looksLikeApiPath } from './http.js';
import { redactSecrets, secretHint } from './redact.js';
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

describe('redactSecrets', () => {
  it.each([
    ['key sk-abcdefghijklmnopqrstuvwxyz123456 used', 'sk-abcdefghijklmnopqrstuvwxyz123456'],
    ['Authorization: Bearer abcdef0123456789abcdef', 'abcdef0123456789abcdef'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['DB_PASSWORD=hunter2hunter2', 'hunter2hunter2'],
    ['"api_key": "abcd1234efgh5678"', 'abcd1234efgh5678'],
    ['-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----', 'MIIabc'],
  ])('removes the secret from %j', (text, secret) => {
    const result = redactSecrets(text);
    expect(result).not.toContain(secret);
    expect(result).toContain('[redacted]');
  });

  it('leaves ordinary text alone', () => {
    const text = 'Ran 12 tests in src/token-parser.ts — all passed.';
    expect(redactSecrets(text)).toBe(text);
  });

  it('gives a hint that cannot reconstruct the secret', () => {
    expect(secretHint('sk-abcdefghijklmnop')).toBe('…mnop');
    expect(secretHint('short')).toBe('…');
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
