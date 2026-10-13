import {
  pluginManifestSchema,
  type PluginIsolationLevel,
  type PluginManifest,
  type PluginPermission,
} from '@agent-studio/protocol';
import type { Database, Migration } from '../../kernel/database.js';
import type { ApprovedSurface } from './manifest.js';

export const PLUGINS_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'plugins and their storage',
    sql: `
      CREATE TABLE plugins (
        id TEXT PRIMARY KEY,
        -- The id as it appears in tool names; two ids that differ only in "." and "-" would collide there.
        tool_prefix TEXT NOT NULL UNIQUE,
        manifest TEXT NOT NULL,
        source TEXT NOT NULL,
        commit_sha TEXT,
        content_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0,
        disabled_reason TEXT,
        -- What went wrong, in a sentence, when the Studio disabled the plugin after repeated failures.
        last_failure TEXT,
        granted TEXT NOT NULL DEFAULT '[]',
        approved_hash TEXT,
        approved_surface TEXT,
        approved_isolation TEXT,
        approved_by TEXT,
        approved_at INTEGER,
        -- Data of an earlier installation with this id was still there when this one was installed.
        retained_data INTEGER NOT NULL DEFAULT 0,
        installed_by TEXT NOT NULL,
        installed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      -- Deliberately not tied to the plugins table: an uninstall may keep the data.
      CREATE TABLE plugin_storage (
        plugin_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        size INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_id, key)
      );
    `,
  },
];

export type StoredSource =
  | { readonly kind: 'git'; readonly url: string; readonly ref: string | null }
  | { readonly kind: 'directory'; readonly name: string };

/** Why a plugin that was enabled no longer is, when the Studio turned it off by itself. */
export type DisabledReason = 'crash-loop' | 'permissions-changed' | 'contributions-changed' | 'content-changed';

export interface PluginRecord {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly source: StoredSource;
  readonly commit: string | null;
  /** Hash of the installed files. */
  readonly contentHash: string;
  readonly enabled: boolean;
  readonly disabledReason: DisabledReason | null;
  /** The failure that got the plugin disabled, kept so it can still be shown after a restart. */
  readonly lastFailure: string | null;
  readonly granted: readonly PluginPermission[];
  /** What the owner approved: the files, … */
  readonly approvedHash: string | null;
  /** … what the manifest asks for and contributes, … */
  readonly approvedSurface: ApprovedSurface | null;
  /** … and how well the process was isolated at the time. */
  readonly approvedIsolation: PluginIsolationLevel | null;
  readonly approvedBy: string | null;
  readonly approvedAt: number | null;
  /** Data of an earlier installation with this id was found when this one was installed. */
  readonly retainedData: boolean;
  readonly installedBy: string;
  readonly installedAt: number;
  readonly updatedAt: number;
}

interface PluginRow {
  id: string;
  manifest: string;
  source: string;
  commit_sha: string | null;
  content_hash: string;
  enabled: number;
  disabled_reason: string | null;
  last_failure: string | null;
  granted: string;
  approved_hash: string | null;
  approved_surface: string | null;
  approved_isolation: string | null;
  approved_by: string | null;
  approved_at: number | null;
  retained_data: number;
  installed_by: string;
  installed_at: number;
  updated_at: number;
}

// Validating a manifest is the expensive part of reading a row, and rows are read often.
const manifestCache = new Map<string, PluginManifest>();

function manifestOf(text: string): PluginManifest {
  let manifest = manifestCache.get(text);
  if (!manifest) {
    // Validated again on the way out: what is in the database is trusted no more than what is on disk.
    manifest = pluginManifestSchema.parse(JSON.parse(text));
    if (manifestCache.size >= 256) manifestCache.clear();
    manifestCache.set(text, manifest);
  }
  return manifest;
}

const toRecord = (row: PluginRow): PluginRecord => ({
  id: row.id,
  manifest: manifestOf(row.manifest),
  source: JSON.parse(row.source) as StoredSource,
  commit: row.commit_sha,
  contentHash: row.content_hash,
  enabled: row.enabled === 1,
  disabledReason: row.disabled_reason as DisabledReason | null,
  lastFailure: row.last_failure,
  granted: JSON.parse(row.granted) as PluginPermission[],
  approvedHash: row.approved_hash,
  approvedSurface: row.approved_surface ? (JSON.parse(row.approved_surface) as ApprovedSurface) : null,
  approvedIsolation: row.approved_isolation as PluginIsolationLevel | null,
  approvedBy: row.approved_by,
  approvedAt: row.approved_at,
  retainedData: row.retained_data === 1,
  installedBy: row.installed_by,
  installedAt: row.installed_at,
  updatedAt: row.updated_at,
});

export interface NewPlugin {
  readonly id: string;
  readonly toolPrefix: string;
  readonly manifest: PluginManifest;
  readonly source: StoredSource;
  readonly commit: string | null;
  readonly contentHash: string;
  readonly retainedData: boolean;
  readonly installedBy: string;
}

export interface PluginPatch {
  manifest?: PluginManifest;
  commit?: string | null;
  contentHash?: string;
  enabled?: boolean;
  disabledReason?: DisabledReason | null;
  lastFailure?: string | null;
  granted?: readonly PluginPermission[];
  approvedHash?: string | null;
  approvedSurface?: ApprovedSurface | null;
  approvedIsolation?: PluginIsolationLevel | null;
  approvedBy?: string | null;
  approvedAt?: number | null;
}

/** The plugins table. Nothing here decides anything; it only keeps what was decided. */
export class PluginStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  list(): PluginRecord[] {
    return this.#db.all<PluginRow>('SELECT * FROM plugins ORDER BY id').map(toRecord);
  }

  get(id: string): PluginRecord | null {
    const row = this.#db.get<PluginRow>('SELECT * FROM plugins WHERE id = ?', id);
    return row ? toRecord(row) : null;
  }

  /** The plugin whose tools would carry the same prefix, if any. */
  idWithToolPrefix(prefix: string): string | null {
    return this.#db.get<{ id: string }>('SELECT id FROM plugins WHERE tool_prefix = ?', prefix)?.id ?? null;
  }

  insert(plugin: NewPlugin): PluginRecord {
    const now = Date.now();
    this.#db.run(
      `INSERT INTO plugins (id, tool_prefix, manifest, source, commit_sha, content_hash, retained_data, installed_by, installed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      plugin.id,
      plugin.toolPrefix,
      JSON.stringify(plugin.manifest),
      JSON.stringify(plugin.source),
      plugin.commit,
      plugin.contentHash,
      plugin.retainedData ? 1 : 0,
      plugin.installedBy,
      now,
      now,
    );
    return this.get(plugin.id)!;
  }

  update(id: string, patch: PluginPatch): PluginRecord {
    const current = this.get(id);
    if (!current) throw new Error(`Plugin "${id}" is not installed.`);
    const pick = <K extends keyof PluginPatch>(key: K, fallback: NonNullable<PluginPatch[K]> | null) =>
      Object.hasOwn(patch, key) ? (patch[key] ?? null) : fallback;
    this.#db.run(
      `UPDATE plugins SET manifest = ?, commit_sha = ?, content_hash = ?, enabled = ?, disabled_reason = ?, last_failure = ?, granted = ?,
         approved_hash = ?, approved_surface = ?, approved_isolation = ?, approved_by = ?, approved_at = ?, updated_at = ?
       WHERE id = ?`,
      JSON.stringify(patch.manifest ?? current.manifest),
      pick('commit', current.commit),
      patch.contentHash ?? current.contentHash,
      (patch.enabled ?? current.enabled) ? 1 : 0,
      pick('disabledReason', current.disabledReason),
      pick('lastFailure', current.lastFailure),
      JSON.stringify(patch.granted ?? current.granted),
      pick('approvedHash', current.approvedHash),
      ((surface) => (surface ? JSON.stringify(surface) : null))(pick('approvedSurface', current.approvedSurface)),
      pick('approvedIsolation', current.approvedIsolation),
      pick('approvedBy', current.approvedBy),
      pick('approvedAt', current.approvedAt),
      Date.now(),
      id,
    );
    return this.get(id)!;
  }

  remove(id: string): void {
    this.#db.run('DELETE FROM plugins WHERE id = ?', id);
  }
}

export const STORAGE_LIMITS = {
  maxKeyLength: 128,
  maxValueBytes: 64 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
  maxKeys: 2000,
} as const;

export type StorageProblem = 'invalid_key' | 'too_large' | 'quota_exceeded';

export class StorageError extends Error {
  readonly code: StorageProblem;

  constructor(code: StorageProblem, message: string) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
  }
}

/**
 * Each plugin's own key-value space. Every statement names the plugin, so one
 * plugin's keys are out of reach of another by construction — there is no call
 * here that takes a key without the plugin it belongs to.
 */
export class PluginStorage {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  static checkKey(key: unknown): asserts key is string {
    // eslint-disable-next-line no-control-regex
    if (typeof key !== 'string' || key.length === 0 || key.length > STORAGE_LIMITS.maxKeyLength || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new StorageError('invalid_key', `A storage key is 1 to ${STORAGE_LIMITS.maxKeyLength} printable characters.`);
    }
  }

  get(pluginId: string, key: string): { found: true; value: unknown } | { found: false } {
    PluginStorage.checkKey(key);
    const row = this.#db.get<{ value: string }>('SELECT value FROM plugin_storage WHERE plugin_id = ? AND key = ?', pluginId, key);
    return row ? { found: true, value: JSON.parse(row.value) as unknown } : { found: false };
  }

  set(pluginId: string, key: string, value: unknown): void {
    PluginStorage.checkKey(key);
    const text = JSON.stringify(value);
    if (text === undefined) throw new StorageError('too_large', 'Only JSON values can be stored.');
    const size = Buffer.byteLength(text, 'utf8');
    if (size > STORAGE_LIMITS.maxValueBytes) {
      throw new StorageError('too_large', `A stored value may be at most ${STORAGE_LIMITS.maxValueBytes} bytes of JSON.`);
    }
    this.#db.transaction(() => {
      const usage = this.usage(pluginId);
      const previous = this.#db.get<{ size: number }>('SELECT size FROM plugin_storage WHERE plugin_id = ? AND key = ?', pluginId, key);
      if (!previous && usage.keys >= STORAGE_LIMITS.maxKeys) {
        throw new StorageError('quota_exceeded', `A plugin may store at most ${STORAGE_LIMITS.maxKeys} keys.`);
      }
      if (usage.bytes - (previous?.size ?? 0) + size > STORAGE_LIMITS.maxTotalBytes) {
        throw new StorageError('quota_exceeded', `A plugin may store at most ${STORAGE_LIMITS.maxTotalBytes} bytes in total.`);
      }
      this.#db.run(
        `INSERT INTO plugin_storage (plugin_id, key, value, size, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (plugin_id, key) DO UPDATE SET value = excluded.value, size = excluded.size, updated_at = excluded.updated_at`,
        pluginId,
        key,
        text,
        size,
        Date.now(),
      );
    });
  }

  delete(pluginId: string, key: string): boolean {
    PluginStorage.checkKey(key);
    return this.#db.run('DELETE FROM plugin_storage WHERE plugin_id = ? AND key = ?', pluginId, key).changes > 0;
  }

  list(pluginId: string, options: { prefix?: string; limit?: number } = {}): string[] {
    const limit = Math.max(1, Math.min(options.limit ?? STORAGE_LIMITS.maxKeys, STORAGE_LIMITS.maxKeys));
    const prefix = options.prefix ?? '';
    // substr() rather than LIKE: a prefix is compared literally, whatever characters it holds.
    return this.#db
      .all<{ key: string }>(
        'SELECT key FROM plugin_storage WHERE plugin_id = ? AND substr(key, 1, ?) = ? ORDER BY key LIMIT ?',
        pluginId,
        Array.from(prefix).length,
        prefix,
        limit,
      )
      .map((row) => row.key);
  }

  usage(pluginId: string): { keys: number; bytes: number } {
    const row = this.#db.get<{ keys: number; bytes: number | null }>(
      'SELECT COUNT(*) AS keys, SUM(size) AS bytes FROM plugin_storage WHERE plugin_id = ?',
      pluginId,
    );
    return { keys: row?.keys ?? 0, bytes: row?.bytes ?? 0 };
  }

  clear(pluginId: string): void {
    this.#db.run('DELETE FROM plugin_storage WHERE plugin_id = ?', pluginId);
  }
}
