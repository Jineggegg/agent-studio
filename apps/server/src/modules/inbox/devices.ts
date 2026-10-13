import { NOTIFICATION_LIMITS, type PushDevice, toOneLine } from '@agent-studio/protocol';
import { SecretBox, sha256 } from '../../kernel/crypto.js';
import type { Database } from '../../kernel/database.js';
import { type Language, text } from './texts.js';
import type { PushSubscription } from './webpush.js';

/**
 * The browsers that receive Web Push for an account.
 *
 * A row holds the subscription (endpoint and the browser's keys) encrypted,
 * a hash of the endpoint for looking it up and for telling a page which row is
 * its own, and the browser sign-in that registered it. The endpoint itself
 * never leaves the server.
 */

export interface DeviceRow {
  id: string;
  user_id: string;
  credential_id: string;
  endpoint_hash: string;
  sealed: string;
  label: string;
  created_at: number;
  last_delivered_at: number | null;
}

/** How long a removed endpoint is remembered, so that the same browser can come back quietly after signing in again. */
export const RETIRED_ENDPOINT_MS = 30 * 24 * 60 * 60 * 1000;

export const endpointHash = (endpoint: string): string => sha256(endpoint);

export function presentDevice(row: DeviceRow, currentHash: string | null): PushDevice {
  return {
    id: row.id,
    label: row.label,
    fingerprint: row.endpoint_hash.slice(0, 16),
    current: currentHash !== null && row.endpoint_hash === currentHash,
    createdAt: row.created_at,
    lastDeliveredAt: row.last_delivered_at,
  };
}

const SYSTEMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/iPad/, 'iPad'],
  [/iPhone|iPod/, 'iPhone'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Macintosh|Mac OS X/, 'Mac'],
  [/Linux|X11/, 'Linux'],
];

// The order matters: most browsers also claim to be the ones further down.
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\/|Chromium\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

/**
 * A name a person recognises ("Chrome on Android", "Safari on iPhone") from
 * what the browser says about itself. Null when it says nothing usable.
 */
export function labelFromUserAgent(userAgent: string | null | undefined, language: Language): string | null {
  if (!userAgent) return null;
  const sample = userAgent.slice(0, 600);
  // An iPad asking for desktop sites calls itself a Mac; nothing in the header tells them apart.
  const system = SYSTEMS.find(([pattern]) => pattern.test(sample))?.[1] ?? null;
  const browser = BROWSERS.find(([pattern]) => pattern.test(sample))?.[1] ?? null;
  if (system !== null && browser !== null) return text(language, 'device.browserOn', { browser, system });
  return browser ?? system;
}

/** When the browser sent no usable description: which push service the device uses says roughly what it is. */
export function labelFromEndpoint(endpoint: string, language: Language): string {
  let host = '';
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    /* not an address: the fallback below applies */
  }
  if (host.endsWith('push.apple.com')) return 'Apple';
  if (host.endsWith('googleapis.com')) return 'Chrome';
  if (host.endsWith('mozilla.com')) return 'Firefox';
  if (host.endsWith('windows.com')) return 'Windows';
  return text(language, 'device.unknown');
}

/** The label to store: what the client sent, cleaned; else derived from the browser; else from the push service. */
export function deviceLabel(input: { label?: string | undefined; userAgent?: string | null | undefined; endpoint: string }, language: Language): string {
  const given = input.label === undefined ? '' : toOneLine(input.label, NOTIFICATION_LIMITS.deviceLabelChars);
  if (given !== '') return given;
  return toOneLine(labelFromUserAgent(input.userAgent, language) ?? labelFromEndpoint(input.endpoint, language), NOTIFICATION_LIMITS.deviceLabelChars);
}

export class DeviceStore {
  readonly #db: Database;
  readonly #box: SecretBox;

  constructor(db: Database, key: Buffer) {
    this.#db = db;
    this.#box = new SecretBox(key);
  }

  seal(deviceId: string, subscription: PushSubscription): string {
    return this.#box.seal(JSON.stringify([subscription.endpoint, subscription.p256dh, subscription.auth]), deviceId);
  }

  /** The subscription of a row, or null when it can no longer be read (the master key was replaced). */
  open(row: DeviceRow): PushSubscription | null {
    try {
      const [endpoint, p256dh, auth] = JSON.parse(this.#box.open(row.sealed, row.id)) as [string, string, string];
      if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') return null;
      return { endpoint, p256dh, auth };
    } catch {
      return null;
    }
  }

  ofUser(userId: string): DeviceRow[] {
    return this.#db.all<DeviceRow>('SELECT * FROM inbox_push_devices WHERE user_id = ? ORDER BY created_at, id', userId);
  }

  count(userId: string): number {
    return this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM inbox_push_devices WHERE user_id = ?', userId)!.n;
  }

  find(userId: string, deviceId: string): DeviceRow | undefined {
    return this.#db.get<DeviceRow>('SELECT * FROM inbox_push_devices WHERE id = ? AND user_id = ?', deviceId, userId);
  }

  byHash(hash: string): DeviceRow | undefined {
    return this.#db.get<DeviceRow>('SELECT * FROM inbox_push_devices WHERE endpoint_hash = ?', hash);
  }

  ofCredential(credentialId: string): DeviceRow[] {
    return this.#db.all<DeviceRow>('SELECT * FROM inbox_push_devices WHERE credential_id = ?', credentialId);
  }

  insert(row: DeviceRow): void {
    this.#db.run(
      `INSERT INTO inbox_push_devices (id, user_id, credential_id, endpoint_hash, sealed, label, created_at, last_delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.user_id,
      row.credential_id,
      row.endpoint_hash,
      row.sealed,
      row.label,
      row.created_at,
      row.last_delivered_at,
    );
  }

  /** The same browser registered again: new keys, perhaps a new sign-in, perhaps a new name. */
  refresh(deviceId: string, patch: { sealed: string; credentialId: string; label: string | null }): void {
    this.#db.run(
      'UPDATE inbox_push_devices SET sealed = ?, credential_id = ?, label = COALESCE(?, label) WHERE id = ?',
      patch.sealed,
      patch.credentialId,
      patch.label,
      deviceId,
    );
  }

  remove(deviceId: string): boolean {
    return this.#db.run('DELETE FROM inbox_push_devices WHERE id = ?', deviceId).changes > 0;
  }

  markDelivered(deviceId: string, at: number): void {
    this.#db.run('UPDATE inbox_push_devices SET last_delivered_at = ? WHERE id = ?', at, deviceId);
  }

  /** Remembers that an endpoint belonged to this account, so its browser may re-register without being announced. */
  retire(userId: string, hash: string, at: number): void {
    this.#db.run(
      `INSERT INTO inbox_push_retired (user_id, endpoint_hash, retired_at) VALUES (?, ?, ?)
       ON CONFLICT (user_id, endpoint_hash) DO UPDATE SET retired_at = excluded.retired_at`,
      userId,
      hash,
      at,
    );
  }

  wasRetired(userId: string, hash: string, now: number): boolean {
    const row = this.#db.get<{ retired_at: number }>('SELECT retired_at FROM inbox_push_retired WHERE user_id = ? AND endpoint_hash = ?', userId, hash);
    return row !== undefined && now - row.retired_at < RETIRED_ENDPOINT_MS;
  }

  forgetRetired(userId: string, hash: string): void {
    this.#db.run('DELETE FROM inbox_push_retired WHERE user_id = ? AND endpoint_hash = ?', userId, hash);
  }

  pruneRetired(now: number): number {
    return this.#db.run('DELETE FROM inbox_push_retired WHERE retired_at <= ?', now - RETIRED_ENDPOINT_MS).changes;
  }
}
