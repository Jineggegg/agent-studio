import { z } from 'zod';
import { newId } from '../../kernel/crypto.js';
import type { Database, Migration } from '../../kernel/database.js';
import type { ModuleContext, StudioModule } from '../../kernel/module.js';
import { redactSecrets } from '../../kernel/redact.js';

declare module '../../kernel/module.js' {
  interface Services {
    audit: AuditLog;
  }
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'audit events',
    sql: `
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        at INTEGER NOT NULL,
        category TEXT NOT NULL,
        action TEXT NOT NULL,
        user_id TEXT,
        subject TEXT,
        detail TEXT NOT NULL DEFAULT '',
        address TEXT
      );
      CREATE INDEX audit_events_at ON audit_events(at);
      CREATE INDEX audit_events_user ON audit_events(user_id, category, at);
    `,
  },
];

/** `change` — something security-relevant was altered; `sign-in` — a successful sign-in; `failure` — a refused attempt. */
export type AuditCategory = 'change' | 'sign-in' | 'failure';

export interface AuditEvent {
  readonly id: string;
  readonly at: number;
  readonly category: AuditCategory;
  /** Stable, dotted name of what happened: "password.changed", "approval.allowed", "pull-request.merged". */
  readonly action: string;
  readonly userId: string | null;
  /** What it was done to, e.g. a project or token name. */
  readonly subject: string | null;
  readonly detail: string;
  /** The client address, shortened so it identifies a network rather than a person. */
  readonly address: string | null;
}

const RETAIN_PER_CATEGORY = 2000;

/** 203.0.113.42 → 203.0.113.x; IPv6 keeps its /48. */
export function maskAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const value = mapped ? mapped[1]! : address;
  if (value.includes('.')) return value.split('.').slice(0, 3).join('.') + '.x';
  if (value === '::1') return value;
  return value.split(':').slice(0, 3).join(':') + '::/48';
}

/**
 * An append-only record of security-relevant events, for the owner to review.
 * Entries never contain secrets: detail text is passed through the redactor
 * and addresses are masked before they are stored.
 */
export class AuditLog {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  record(entry: { category: AuditCategory; action: string; userId?: string | null; subject?: string | null; detail?: string; address?: string | null }): void {
    this.#db.run(
      'INSERT INTO audit_events (id, at, category, action, user_id, subject, detail, address) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      newId(),
      Date.now(),
      entry.category,
      entry.action,
      entry.userId ?? null,
      entry.subject ? redactSecrets(entry.subject).slice(0, 200) : null,
      redactSecrets(entry.detail ?? '').slice(0, 500),
      maskAddress(entry.address),
    );
  }

  list(options: { category?: AuditCategory; userId?: string; limit: number }): AuditEvent[] {
    return this.#db
      .all<{ id: string; at: number; category: AuditCategory; action: string; user_id: string | null; subject: string | null; detail: string; address: string | null }>(
        `SELECT * FROM audit_events
         WHERE (? IS NULL OR category = ?) AND (? IS NULL OR user_id = ?)
         ORDER BY at DESC, id DESC LIMIT ?`,
        options.category ?? null,
        options.category ?? null,
        options.userId ?? null,
        options.userId ?? null,
        options.limit,
      )
      .map((row) => ({
        id: row.id,
        at: row.at,
        category: row.category,
        action: row.action,
        userId: row.user_id,
        subject: row.subject,
        detail: row.detail,
        address: row.address,
      }));
  }

  /** Keeps each category bounded so a flood of failures cannot push out the record of real changes. */
  prune(): void {
    for (const category of ['change', 'sign-in', 'failure'] as const) {
      this.#db.run(
        `DELETE FROM audit_events WHERE category = ? AND id NOT IN (
           SELECT id FROM audit_events WHERE category = ? ORDER BY at DESC, id DESC LIMIT ?
         )`,
        category,
        category,
        RETAIN_PER_CATEGORY,
      );
    }
  }
}

const listQuery = z.object({
  category: z.enum(['change', 'sign-in', 'failure']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const auditModule: StudioModule = {
  name: 'audit',
  migrations: MIGRATIONS,

  setup(context: ModuleContext) {
    const audit = new AuditLog(context.db);
    context.services.audit = audit;

    // The owner sees everything; anyone else sees only their own events.
    context.http.route({
      method: 'GET',
      url: '/api/audit',
      access: 'user',
      query: listQuery,
      handler: ({ user, query }) => ({
        events: audit.list({
          ...(query.category ? { category: query.category } : {}),
          ...(user.role === 'owner' ? {} : { userId: user.userId }),
          limit: query.limit,
        }),
      }),
    });
  },

  start(context) {
    context.services.audit.prune();
  },
};
