import { NOTIFICATION_LIMITS, type NotificationKind } from '@agent-studio/protocol';
import type { Database, SqlValue } from '../../kernel/database.js';

export interface NotificationRow {
  id: string;
  user_id: string;
  kind: NotificationKind;
  title: string;
  body: string;
  detail: string | null;
  link: string;
  tag: string;
  session_id: string | null;
  run_id: string | null;
  project_id: string | null;
  created_at: number;
  read_at: number | null;
}

/**
 * Stored notifications. Every statement names the user: a row is never
 * fetched by id alone and checked afterwards.
 */
export class NotificationStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Stores a notification in place of any older one with the same tag, and
   * keeps the user's list within its bounds. Returns the ids that went away.
   */
  put(row: NotificationRow): { replaced: string[]; pruned: number } {
    return this.#db.transaction(() => {
      const replaced = this.#db
        .all<{ id: string }>('SELECT id FROM inbox_notifications WHERE user_id = ? AND tag = ?', row.user_id, row.tag)
        .map((entry) => entry.id);
      this.#db.run('DELETE FROM inbox_notifications WHERE user_id = ? AND tag = ?', row.user_id, row.tag);
      this.#db.run(
        `INSERT INTO inbox_notifications (id, user_id, kind, title, body, detail, link, tag, session_id, run_id, project_id, created_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.user_id,
        row.kind,
        row.title,
        row.body,
        row.detail,
        row.link,
        row.tag,
        row.session_id,
        row.run_id,
        row.project_id,
        row.created_at,
        row.read_at,
      );
      return { replaced, pruned: this.prune(row.user_id, row.created_at) };
    });
  }

  /** Removes what is too old and what exceeds the per-user count, oldest first. */
  prune(userId: string, now: number): number {
    const aged = this.#db.run('DELETE FROM inbox_notifications WHERE user_id = ? AND created_at <= ?', userId, now - NOTIFICATION_LIMITS.maxAgeMs).changes;
    const excess = this.#db.run(
      `DELETE FROM inbox_notifications WHERE user_id = ? AND id NOT IN (
         SELECT id FROM inbox_notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
       )`,
      userId,
      userId,
      NOTIFICATION_LIMITS.perUser,
    ).changes;
    return aged + excess;
  }

  /** Start-up housekeeping: age only; the count is kept on every insert. */
  pruneAged(now: number): number {
    return this.#db.run('DELETE FROM inbox_notifications WHERE created_at <= ?', now - NOTIFICATION_LIMITS.maxAgeMs).changes;
  }

  list(userId: string, options: { order: 'unread-first' | 'newest'; unreadOnly: boolean; limit: number; offset: number }): NotificationRow[] {
    const order = options.order === 'unread-first' ? '(read_at IS NOT NULL), created_at DESC, id DESC' : 'created_at DESC, id DESC';
    return this.#db.all<NotificationRow>(
      `SELECT * FROM inbox_notifications WHERE user_id = ? AND (? = 0 OR read_at IS NULL) ORDER BY ${order} LIMIT ? OFFSET ?`,
      userId,
      options.unreadOnly ? 1 : 0,
      options.limit,
      options.offset,
    );
  }

  find(userId: string, id: string): NotificationRow | undefined {
    return this.#db.get<NotificationRow>('SELECT * FROM inbox_notifications WHERE id = ? AND user_id = ?', id, userId);
  }

  unread(userId: string): number {
    return this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM inbox_notifications WHERE user_id = ? AND read_at IS NULL', userId)!.n;
  }

  markRead(userId: string, id: string, at: number): boolean {
    return this.#db.run('UPDATE inbox_notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', at, id, userId).changes > 0;
  }

  /** Everything of the user, or only what is about one session. */
  markAllRead(userId: string, at: number, sessionId?: string): number {
    const params: SqlValue[] = [at, userId];
    let where = 'user_id = ? AND read_at IS NULL';
    if (sessionId !== undefined) {
      where += ' AND session_id = ?';
      params.push(sessionId);
    }
    return this.#db.run(`UPDATE inbox_notifications SET read_at = ? WHERE ${where}`, ...params).changes;
  }

  /** Marks one kind of notification about a session read, for everyone who got it. Returns whose lists changed. */
  markKindRead(sessionId: string, kind: NotificationKind, at: number): string[] {
    const users = this.#db
      .all<{ user_id: string }>('SELECT DISTINCT user_id FROM inbox_notifications WHERE session_id = ? AND kind = ? AND read_at IS NULL', sessionId, kind)
      .map((row) => row.user_id);
    if (users.length > 0) this.#db.run('UPDATE inbox_notifications SET read_at = ? WHERE session_id = ? AND kind = ? AND read_at IS NULL', at, sessionId, kind);
    return users;
  }

  remove(userId: string, id: string): boolean {
    return this.#db.run('DELETE FROM inbox_notifications WHERE id = ? AND user_id = ?', id, userId).changes > 0;
  }

  clear(userId: string, scope: 'read' | 'all'): number {
    return this.#db.run(`DELETE FROM inbox_notifications WHERE user_id = ? AND (? = 1 OR read_at IS NOT NULL)`, userId, scope === 'all' ? 1 : 0).changes;
  }
}
