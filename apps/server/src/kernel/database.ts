import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

export type SqlValue = SQLInputValue;

export interface Migration {
  /** Monotonic within a module, starting at 1. Never renumber or edit an applied migration. */
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/**
 * Thin wrapper over the SQLite engine built into Node. Statements are always
 * prepared with bound parameters — there is no API here that interpolates
 * values into SQL text.
 */
export class Database {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();
  #depth = 0;

  constructor(file: string) {
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    this.#db.exec('PRAGMA foreign_keys = ON');
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        module TEXT NOT NULL,
        version INTEGER NOT NULL,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        PRIMARY KEY (module, version)
      )
    `);
  }

  #prepare(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  /** Runs schema or multi-statement SQL that takes no parameters. */
  exec(sql: string): void {
    this.#db.exec(sql);
  }

  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number } {
    const result = this.#prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.#prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.#prepare(sql).all(...params) as T[];
  }

  /** Runs `work` atomically. Nested calls become savepoints. `work` must be synchronous. */
  transaction<T>(work: () => T): T {
    const savepoint = `sp_${this.#depth}`;
    this.#db.exec(this.#depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`);
    this.#depth += 1;
    try {
      const result = work();
      this.#depth -= 1;
      this.#db.exec(this.#depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      this.#depth -= 1;
      this.#db.exec(this.#depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    }
  }

  /** Applies a module's pending migrations in order, each in its own transaction. */
  migrate(module: string, migrations: readonly Migration[]): number {
    const applied = new Set(
      this.all<{ version: number }>('SELECT version FROM schema_migrations WHERE module = ?', module).map(
        (row) => row.version,
      ),
    );
    const ordered = [...migrations].sort((a, b) => a.version - b.version);
    ordered.forEach((migration, index) => {
      if (migration.version !== index + 1) {
        throw new Error(`Module "${module}": migrations must be numbered 1..n without gaps.`);
      }
    });
    let count = 0;
    for (const migration of ordered) {
      if (applied.has(migration.version)) continue;
      this.transaction(() => {
        this.#db.exec(migration.sql);
        this.run(
          'INSERT INTO schema_migrations (module, version, name, applied_at) VALUES (?, ?, ?, ?)',
          module,
          migration.version,
          migration.name,
          Date.now(),
        );
      });
      count += 1;
    }
    return count;
  }

  close(): void {
    this.#statements.clear();
    this.#db.close();
  }
}

/** SQLite has no boolean type. */
export const toSql = (value: boolean): number => (value ? 1 : 0);

/** Escapes the wildcard characters of a LIKE pattern; use with `ESCAPE '\\'`. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (match) => `\\${match}`);
}
