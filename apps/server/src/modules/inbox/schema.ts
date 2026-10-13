import type { Migration } from '../../kernel/database.js';

export const INBOX_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'stored notifications, push devices',
    sql: `
      -- One line telling one user that something happened. The task inbox is not stored: it is read live from the runtime.
      CREATE TABLE inbox_notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        -- One more line for the app's own list; never on a lock screen unless the user asked for details.
        detail TEXT,
        -- Always a path inside the app.
        link TEXT NOT NULL,
        -- A newer notification with the same tag replaces the older one.
        tag TEXT NOT NULL,
        session_id TEXT,
        run_id TEXT,
        project_id TEXT,
        created_at INTEGER NOT NULL,
        read_at INTEGER
      );
      CREATE UNIQUE INDEX inbox_notifications_tag ON inbox_notifications(user_id, tag);
      CREATE INDEX inbox_notifications_user ON inbox_notifications(user_id, created_at);
      CREATE INDEX inbox_notifications_session ON inbox_notifications(user_id, session_id);

      -- A browser that receives Web Push for an account.
      CREATE TABLE inbox_push_devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        -- The browser sign-in that registered it. The subscription ends with that sign-in.
        credential_id TEXT NOT NULL,
        -- SHA-256 of the endpoint. An endpoint belongs to one account at a time.
        endpoint_hash TEXT NOT NULL UNIQUE,
        -- The endpoint and the browser's keys, encrypted.
        sealed TEXT NOT NULL,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_delivered_at INTEGER
      );
      CREATE INDEX inbox_push_devices_user ON inbox_push_devices(user_id, created_at);
      CREATE INDEX inbox_push_devices_credential ON inbox_push_devices(credential_id);

      -- Endpoints removed because their browser was signed out. The same browser may come back without ceremony for a while.
      CREATE TABLE inbox_push_retired (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint_hash TEXT NOT NULL,
        retired_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, endpoint_hash)
      );
    `,
  },
];
