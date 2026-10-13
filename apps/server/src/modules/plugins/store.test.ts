import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pluginManifestSchema } from '@agent-studio/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../kernel/database.js';
import { PLUGINS_MIGRATIONS, PluginStorage, PluginStore, STORAGE_LIMITS, StorageError } from './store.js';

let directory: string;
let db: Database;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'plugin-store-'));
  db = new Database(path.join(directory, 'test.db'));
  db.migrate('plugins', PLUGINS_MIGRATIONS);
});
afterEach(async () => {
  db.close();
  await rm(directory, { recursive: true, force: true });
});

const code = (work: () => unknown): string => {
  try {
    work();
    return 'ok';
  } catch (error) {
    if (error instanceof StorageError) return error.code;
    throw error;
  }
};

describe('plugin storage', () => {
  it('keeps each plugin to its own keys', () => {
    const storage = new PluginStorage(db);
    storage.set('alpha', 'token', { secret: 'alpha-only' });
    storage.set('beta', 'token', 'beta-only');
    storage.set('beta', 'other', 1);
    expect(storage.get('alpha', 'token')).toEqual({ found: true, value: { secret: 'alpha-only' } });
    expect(storage.get('beta', 'token')).toEqual({ found: true, value: 'beta-only' });
    expect(storage.get('alpha', 'other')).toEqual({ found: false });
    expect(storage.list('alpha')).toEqual(['token']);
    expect(storage.list('beta')).toEqual(['other', 'token']);
    expect(storage.delete('alpha', 'other')).toBe(false);
    expect(storage.delete('beta', 'other')).toBe(true);
    storage.clear('alpha');
    expect(storage.get('alpha', 'token')).toEqual({ found: false });
    expect(storage.get('beta', 'token')).toEqual({ found: true, value: 'beta-only' });
  });

  it('treats keys as plain text, whatever they look like', () => {
    const storage = new PluginStorage(db);
    storage.set('alpha', 'secret', 'alpha');
    for (const key of ['alpha:secret', '../alpha/secret', "' OR '1'='1", '%', '_ecret', "secret' --"]) {
      expect(storage.get('beta', key)).toEqual({ found: false });
    }
    storage.set('beta', '100%', 1);
    storage.set('beta', '100x', 2);
    storage.set('beta', 'a_b', 3);
    storage.set('beta', 'axb', 4);
    expect(storage.list('beta', { prefix: '100%' })).toEqual(['100%']);
    expect(storage.list('beta', { prefix: 'a_' })).toEqual(['a_b']);
    expect(storage.list('beta', { prefix: '%' })).toEqual([]);
    expect(storage.list('beta', { prefix: '', limit: 2 })).toEqual(['100%', '100x']);
  });

  it('caps key length, value size, the number of keys and the total', () => {
    const storage = new PluginStorage(db);
    expect(code(() => storage.set('p', '', 1))).toBe('invalid_key');
    expect(code(() => storage.set('p', 'k'.repeat(STORAGE_LIMITS.maxKeyLength + 1), 1))).toBe('invalid_key');
    expect(code(() => storage.set('p', 'a\u0000b', 1))).toBe('invalid_key');
    expect(code(() => storage.get('p', 5 as never))).toBe('invalid_key');
    expect(code(() => storage.set('p', 'fn', (() => 1) as never))).toBe('too_large');
    expect(code(() => storage.set('p', 'big', 'x'.repeat(STORAGE_LIMITS.maxValueBytes)))).toBe('too_large');
    expect(code(() => storage.set('p', 'ok', 'x'.repeat(STORAGE_LIMITS.maxValueBytes - 2)))).toBe('ok');

    const chunk = 'y'.repeat(STORAGE_LIMITS.maxValueBytes - 2);
    let stored = 1;
    let outcome = 'ok';
    while (outcome === 'ok' && stored < 200) {
      outcome = code(() => storage.set('p', `chunk-${stored}`, chunk));
      stored += 1;
    }
    expect(outcome).toBe('quota_exceeded');
    expect(storage.usage('p').bytes).toBeLessThanOrEqual(STORAGE_LIMITS.maxTotalBytes);
    // Replacing a value counts the difference, not the sum.
    expect(code(() => storage.set('p', 'ok', 'small'))).toBe('ok');
    // Another plugin's quota is its own.
    expect(code(() => storage.set('q', 'ok', chunk))).toBe('ok');

    for (let i = 0; i < STORAGE_LIMITS.maxKeys; i += 1) storage.set('many', `k${i}`, i);
    expect(code(() => storage.set('many', 'one-more', 1))).toBe('quota_exceeded');
    expect(code(() => storage.set('many', 'k0', 'replaced'))).toBe('ok');
  });
});

describe('plugin records', () => {
  const manifest = pluginManifestSchema.parse({ manifestVersion: 1, id: 'demo', name: 'Demo', version: '1.0.0' });

  it('starts disabled with nothing granted, and changes only what a patch names', () => {
    const store = new PluginStore(db);
    const inserted = store.insert({
      id: 'demo',
      toolPrefix: 'demo',
      manifest,
      source: { kind: 'directory', name: 'demo' },
      commit: null,
      contentHash: 'sha256:a',
      retainedData: false,
      installedBy: 'u1',
    });
    expect(inserted).toMatchObject({ enabled: false, granted: [], approvedHash: null, approvedSurface: null, approvedIsolation: null, disabledReason: null });
    const enabled = store.update('demo', { enabled: true, granted: ['notifications'], approvedHash: 'sha256:a', approvedSurface: { permissions: [], contributions: 'c' }, approvedIsolation: 'sandboxed' });
    expect(enabled).toMatchObject({ enabled: true, granted: ['notifications'], approvedSurface: { permissions: [], contributions: 'c' }, approvedIsolation: 'sandboxed' });
    const disabled = store.update('demo', { enabled: false, disabledReason: 'crash-loop', lastFailure: 'it fell over' });
    expect(disabled).toMatchObject({ enabled: false, disabledReason: 'crash-loop', lastFailure: 'it fell over', granted: ['notifications'], approvedHash: 'sha256:a' });
    expect(store.update('demo', { disabledReason: null, lastFailure: null })).toMatchObject({ disabledReason: null, lastFailure: null });
    expect(store.idWithToolPrefix('demo')).toBe('demo');
    expect(store.idWithToolPrefix('other')).toBeNull();
    store.remove('demo');
    expect(store.get('demo')).toBeNull();
    expect(() => store.update('demo', { enabled: true })).toThrow();
  });

  it('refuses two plugins whose tools would share a prefix', () => {
    const store = new PluginStore(db);
    const record = { manifest, source: { kind: 'directory' as const, name: 'x' }, commit: null, contentHash: 'h', retainedData: false, installedBy: 'u1' };
    store.insert({ ...record, id: 'a-b', toolPrefix: 'a_b' });
    expect(() => store.insert({ ...record, id: 'a.b', toolPrefix: 'a_b' })).toThrow();
  });
});
