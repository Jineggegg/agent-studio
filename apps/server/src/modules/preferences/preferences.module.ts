import { MAX_PREFERENCE_BYTES, PREFERENCES_CHANGED, type Preferences, updatePreferencesRequestSchema } from '@agent-studio/protocol';
import type { Database, Migration } from '../../kernel/database.js';
import { payloadTooLarge } from '../../kernel/errors.js';
import type { EventBus } from '../../kernel/events.js';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';

declare module '../../kernel/module.js' {
  interface Services {
    preferences: PreferencesService;
  }
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'user preferences',
    sql: `
      CREATE TABLE user_preferences (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, key)
      );
    `,
  },
];

const MAX_KEYS_PER_USER = 500;

/**
 * Small per-account settings that follow the user across devices. The server
 * is the authority; a change is pushed to the account's other open pages.
 */
export class PreferencesService {
  readonly #db: Database;
  readonly #bus: EventBus;

  constructor(deps: { db: Database; bus: EventBus }) {
    this.#db = deps.db;
    this.#bus = deps.bus;
  }

  all(userId: string): Preferences {
    const result: Preferences = {};
    for (const row of this.#db.all<{ key: string; value: string }>('SELECT key, value FROM user_preferences WHERE user_id = ?', userId)) {
      result[row.key] = JSON.parse(row.value) as unknown;
    }
    return result;
  }

  get<T>(userId: string, key: string): T | undefined {
    const row = this.#db.get<{ value: string }>('SELECT value FROM user_preferences WHERE user_id = ? AND key = ?', userId, key);
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  /** Applies a patch key by key; a null value removes the key. */
  patch(userId: string, values: Record<string, unknown>): Preferences {
    const now = Date.now();
    this.#db.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        if (value === null || value === undefined) {
          this.#db.run('DELETE FROM user_preferences WHERE user_id = ? AND key = ?', userId, key);
          continue;
        }
        const encoded = JSON.stringify(value);
        if (Buffer.byteLength(encoded) > MAX_PREFERENCE_BYTES) {
          throw payloadTooLarge(`The value for "${key}" is too large.`);
        }
        this.#db.run(
          `INSERT INTO user_preferences (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          userId,
          key,
          encoded,
          now,
        );
      }
      const count = this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM user_preferences WHERE user_id = ?', userId)!.n;
      if (count > MAX_KEYS_PER_USER) throw payloadTooLarge('Too many preferences are stored for this account.');
    });
    this.#bus.publish(`user:${userId}`, PREFERENCES_CHANGED, { values });
    return this.all(userId);
  }
}

export const preferencesModule: StudioModule = {
  name: 'preferences',
  migrations: MIGRATIONS,

  setup(context: ModuleContext) {
    const preferences = new PreferencesService(context);
    context.services.preferences = preferences;

    context.http.route({
      method: 'GET',
      url: '/api/preferences',
      access: 'user',
      handler: ({ user }) => ({ values: preferences.all(user.userId) }),
    });
    context.http.route({
      method: 'PATCH',
      url: '/api/preferences',
      access: 'user',
      body: updatePreferencesRequestSchema,
      bodyLimit: 256 * 1024,
      handler: ({ user, body }) => ({ values: preferences.patch(user.userId, body.values) }),
    });
  },
};
