import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Database } from '../../kernel/database.js';
import { KeyRing } from '../../kernel/secrets.js';
import { type DeviceRow, DeviceStore, RETIRED_ENDPOINT_MS, deviceLabel, endpointHash, labelFromEndpoint, labelFromUserAgent, presentDevice } from './devices.js';
import { INBOX_MIGRATIONS } from './schema.js';

describe('a name for a device', () => {
  const agents: Array<[string, string]> = [
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36', 'Chrome on Android'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari on iPhone'],
    ['Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', 'Safari on iPad'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.54 Mobile/15E148 Safari/604.1', 'Chrome on iPhone'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', 'Safari on Mac'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0', 'Edge on Windows'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0', 'Firefox on Windows'],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0', 'Firefox on Linux'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Chrome on ChromeOS'],
    ['Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36', 'Samsung Internet on Android'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/111.0.0.0', 'Opera on Windows'],
  ];

  it.each(agents)('reads %s', (userAgent, expected) => {
    expect(labelFromUserAgent(userAgent, 'en')).toBe(expected);
  });

  it('is written in the user\'s language, and says nothing when the browser says nothing usable', () => {
    expect(labelFromUserAgent(agents[1]![0], 'zh-CN')).toBe('iPhone 上的 Safari');
    expect(labelFromUserAgent('curl/8.5.0', 'en')).toBeNull();
    expect(labelFromUserAgent('', 'en')).toBeNull();
    expect(labelFromUserAgent(null, 'en')).toBeNull();
    // Half a description is still better than none.
    expect(labelFromUserAgent('SomeBot (Windows NT 10.0)', 'en')).toBe('Windows');
  });

  it('falls back to what the push service says about the device', () => {
    expect(labelFromEndpoint('https://web.push.apple.com/QGx…', 'en')).toBe('Apple');
    expect(labelFromEndpoint('https://fcm.googleapis.com/fcm/send/abc', 'en')).toBe('Chrome');
    expect(labelFromEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc', 'en')).toBe('Firefox');
    expect(labelFromEndpoint('https://db5p.notify.windows.com/w/?token=abc', 'en')).toBe('Windows');
    expect(labelFromEndpoint('http://127.0.0.1:9/push/x', 'en')).toBe('Browser');
    expect(labelFromEndpoint('https://push.example-googleapis.com/x', 'en')).toBe('Browser'); // a look-alike name is not the service
    expect(labelFromEndpoint('not an address', 'zh-CN')).toBe('浏览器');
  });

  it('prefers what the client called it — one clean line of at most forty characters', () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    expect(deviceLabel({ label: '  My\nphone\u0007  ', userAgent: agents[0]![0], endpoint }, 'en')).toBe('My phone');
    expect(deviceLabel({ label: 'x'.repeat(100), endpoint }, 'en')).toHaveLength(40);
    expect(deviceLabel({ label: ' \n ', userAgent: agents[0]![0], endpoint }, 'en')).toBe('Chrome on Android');
    expect(deviceLabel({ userAgent: null, endpoint }, 'en')).toBe('Chrome');
  });
});

describe('stored subscriptions', () => {
  let directory: string;
  let db: Database;
  let store: DeviceStore;
  const USER = 'u'.repeat(26);
  const OTHER = 'o'.repeat(26);
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/secret-endpoint-token', p256dh: 'B'.repeat(87), auth: 'authauthauthauthauthau' };

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'inbox-devices-'));
    db = new Database(path.join(directory, 'test.db'));
    db.exec('CREATE TABLE users (id TEXT PRIMARY KEY);');
    db.run('INSERT INTO users (id) VALUES (?), (?)', USER, OTHER);
    db.migrate('inbox', INBOX_MIGRATIONS);
    store = new DeviceStore(db, new KeyRing(Buffer.alloc(32, 7)).derive('inbox.push-subscriptions'));
  });
  afterEach(() => {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const row = (id: string, userId = USER, endpoint = subscription.endpoint): DeviceRow => ({
    id,
    user_id: userId,
    credential_id: 'c'.repeat(26),
    endpoint_hash: endpointHash(endpoint),
    sealed: store.seal(id, { ...subscription, endpoint }),
    label: 'Chrome on Android',
    created_at: 1000,
    last_delivered_at: null,
  });

  it('are encrypted at rest and bound to their row', () => {
    const first = row('d'.repeat(26));
    store.insert(first);
    const raw = JSON.stringify(db.all('SELECT * FROM inbox_push_devices'));
    for (const secret of ['secret-endpoint-token', subscription.auth, subscription.p256dh]) expect(raw).not.toContain(secret);
    expect(store.open(store.find(USER, first.id)!)).toEqual(subscription);
    // A sealed value copied to another row does not open there; neither does it under another key.
    expect(store.open({ ...first, id: 'e'.repeat(26) })).toBeNull();
    const otherKey = new DeviceStore(db, new KeyRing(Buffer.alloc(32, 9)).derive('inbox.push-subscriptions'));
    expect(otherKey.open(first)).toBeNull();
    expect(store.open({ ...first, sealed: 'garbage' })).toBeNull();
  });

  it('are found only by their own user, and an endpoint is stored once', () => {
    const mine = row('d'.repeat(26));
    store.insert(mine);
    expect(store.find(USER, mine.id)).toBeDefined();
    expect(store.find(OTHER, mine.id)).toBeUndefined();
    expect(store.ofUser(OTHER)).toEqual([]);
    expect(store.count(USER)).toBe(1);
    expect(store.byHash(endpointHash(subscription.endpoint))?.id).toBe(mine.id);
    // The same endpoint for somebody else cannot be stored beside it.
    expect(() => store.insert(row('f'.repeat(26), OTHER))).toThrow(/UNIQUE/);
    // Deleting the account takes its devices along.
    db.run('DELETE FROM users WHERE id = ?', USER);
    expect(store.byHash(endpointHash(subscription.endpoint))).toBeUndefined();
  });

  it('show a page its own row by a fingerprint, never by the endpoint', () => {
    const mine = row('d'.repeat(26));
    const hash = endpointHash(subscription.endpoint);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(presentDevice(mine, hash)).toEqual({ id: mine.id, label: 'Chrome on Android', fingerprint: hash.slice(0, 16), current: true, createdAt: 1000, lastDeliveredAt: null });
    expect(presentDevice(mine, null).current).toBe(false);
    expect(presentDevice(mine, endpointHash('https://fcm.googleapis.com/other')).current).toBe(false);
    expect(JSON.stringify(presentDevice(mine, hash))).not.toContain('secret-endpoint-token');
  });

  it('remember a removed endpoint for thirty days, per user', () => {
    const hash = endpointHash(subscription.endpoint);
    const now = 1_000_000_000;
    expect(store.wasRetired(USER, hash, now)).toBe(false);
    store.retire(USER, hash, now);
    expect(store.wasRetired(USER, hash, now + 1)).toBe(true);
    expect(store.wasRetired(OTHER, hash, now + 1)).toBe(false);
    expect(store.wasRetired(USER, hash, now + RETIRED_ENDPOINT_MS - 1)).toBe(true);
    expect(store.wasRetired(USER, hash, now + RETIRED_ENDPOINT_MS)).toBe(false);
    // Retiring again renews it; pruning removes only what has run out.
    store.retire(USER, hash, now + 5);
    store.retire(OTHER, endpointHash('https://fcm.googleapis.com/other'), now - RETIRED_ENDPOINT_MS);
    expect(store.pruneRetired(now + 10)).toBe(1);
    expect(store.wasRetired(USER, hash, now + 10)).toBe(true);
    store.forgetRetired(USER, hash);
    expect(store.wasRetired(USER, hash, now + 10)).toBe(false);
  });
});
