import type { Database } from '../../kernel/database.js';

export interface ThrottleOptions {
  /** Failures allowed before waits begin. */
  readonly freeAttempts?: number;
  /** First wait; doubles with each further failure. */
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** A key with no failure for this long starts afresh. */
  readonly forgetAfterMs?: number;
}

interface Entry {
  failures: number;
  lockedUntil: number;
  lastFailure: number;
}

/**
 * Slows down guessing. Failures are counted per key (an account name, a
 * session, a client address); after a few, each further failure doubles the
 * wait. With a database the state survives restarts, so restarting the
 * service is not a way around a lock.
 */
export class AttemptThrottle {
  readonly #memory = new Map<string, Entry>();
  readonly #db: Database | null;
  readonly #freeAttempts: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #forgetAfterMs: number;

  constructor(options: ThrottleOptions = {}, db: Database | null = null) {
    this.#db = db;
    this.#freeAttempts = options.freeAttempts ?? 5;
    this.#baseDelayMs = options.baseDelayMs ?? 30_000;
    this.#maxDelayMs = options.maxDelayMs ?? 15 * 60_000;
    this.#forgetAfterMs = options.forgetAfterMs ?? 60 * 60_000;
  }

  #read(key: string): Entry | undefined {
    if (!this.#db) return this.#memory.get(key);
    const row = this.#db.get<{ failures: number; locked_until: number; last_failure: number }>(
      'SELECT failures, locked_until, last_failure FROM auth_throttle WHERE key = ?',
      key,
    );
    return row ? { failures: row.failures, lockedUntil: row.locked_until, lastFailure: row.last_failure } : undefined;
  }

  #write(key: string, entry: Entry): void {
    if (!this.#db) {
      this.#memory.set(key, entry);
      if (this.#memory.size > 10_000) this.prune();
      return;
    }
    this.#db.run(
      `INSERT INTO auth_throttle (key, failures, locked_until, last_failure) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until, last_failure = excluded.last_failure`,
      key,
      entry.failures,
      entry.lockedUntil,
      entry.lastFailure,
    );
  }

  #remove(key: string): void {
    if (this.#db) this.#db.run('DELETE FROM auth_throttle WHERE key = ?', key);
    else this.#memory.delete(key);
  }

  /** Seconds the caller must still wait, or 0 when an attempt is allowed. */
  retryAfter(key: string, now = Date.now()): number {
    const entry = this.#read(key);
    if (!entry) return 0;
    if (now - entry.lastFailure > this.#forgetAfterMs) {
      this.#remove(key);
      return 0;
    }
    return entry.lockedUntil > now ? Math.ceil((entry.lockedUntil - now) / 1000) : 0;
  }

  /** When the key is locked until (ms), or null. */
  lockedUntil(key: string, now = Date.now()): number | null {
    return this.retryAfter(key, now) > 0 ? this.#read(key)!.lockedUntil : null;
  }

  recordFailure(key: string, now = Date.now()): void {
    const previous = this.#read(key);
    const entry: Entry =
      previous && now - previous.lastFailure <= this.#forgetAfterMs
        ? { ...previous }
        : { failures: 0, lockedUntil: 0, lastFailure: now };
    entry.failures += 1;
    entry.lastFailure = now;
    if (entry.failures >= this.#freeAttempts) {
      const exponent = Math.min(entry.failures - this.#freeAttempts, 16);
      entry.lockedUntil = now + Math.min(this.#baseDelayMs * 2 ** exponent, this.#maxDelayMs);
    }
    this.#write(key, entry);
  }

  recordSuccess(key: string): void {
    this.#remove(key);
  }

  /**
   * Takes back one counted attempt. Attempts are counted *before* the secret is
   * compared, so that a burst of parallel guesses cannot all be evaluated; a
   * caller that then succeeds, but must not wipe the whole count, undoes its own.
   */
  undoFailure(key: string): void {
    const entry = this.#read(key);
    if (!entry) return;
    entry.failures -= 1;
    if (entry.failures <= 0) return this.#remove(key);
    if (entry.failures < this.#freeAttempts) entry.lockedUntil = 0;
    this.#write(key, entry);
  }

  /** Forgets every key with the given prefix (for example all locks of one account). */
  clear(prefix = ''): number {
    if (this.#db) {
      return this.#db.run(`DELETE FROM auth_throttle WHERE key LIKE ? ESCAPE '\\'`, prefix.replace(/[\\%_]/g, '\\$&') + '%').changes;
    }
    let removed = 0;
    for (const key of [...this.#memory.keys()]) {
      if (key.startsWith(prefix)) {
        this.#memory.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  prune(now = Date.now()): void {
    if (this.#db) {
      // The longest window any throttle on this table uses is a day.
      this.#db.run('DELETE FROM auth_throttle WHERE last_failure < ?', now - 2 * 24 * 60 * 60_000);
      return;
    }
    for (const [key, entry] of this.#memory) {
      if (now - entry.lastFailure > this.#forgetAfterMs) this.#memory.delete(key);
    }
  }
}
