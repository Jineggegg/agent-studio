/**
 * Slows down password guessing. Failures are counted per key (an account
 * name, a client address); after a few, each further failure doubles the wait.
 * Kept in memory: a restart forgives, which is acceptable for a throttle
 * whose job is to make online guessing impractical, not to be a ledger.
 */
export class AttemptThrottle {
  readonly #entries = new Map<string, { failures: number; lockedUntil: number; lastFailure: number }>();
  readonly #freeAttempts: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #forgetAfterMs: number;

  constructor(options: { freeAttempts?: number; baseDelayMs?: number; maxDelayMs?: number; forgetAfterMs?: number } = {}) {
    this.#freeAttempts = options.freeAttempts ?? 5;
    this.#baseDelayMs = options.baseDelayMs ?? 30_000;
    this.#maxDelayMs = options.maxDelayMs ?? 15 * 60_000;
    this.#forgetAfterMs = options.forgetAfterMs ?? 60 * 60_000;
  }

  /** Seconds the caller must still wait, or 0 when an attempt is allowed. */
  retryAfter(key: string, now = Date.now()): number {
    const entry = this.#entries.get(key);
    if (!entry) return 0;
    if (now - entry.lastFailure > this.#forgetAfterMs) {
      this.#entries.delete(key);
      return 0;
    }
    return entry.lockedUntil > now ? Math.ceil((entry.lockedUntil - now) / 1000) : 0;
  }

  recordFailure(key: string, now = Date.now()): void {
    const entry = this.#entries.get(key) ?? { failures: 0, lockedUntil: 0, lastFailure: now };
    entry.failures += 1;
    entry.lastFailure = now;
    if (entry.failures >= this.#freeAttempts) {
      const exponent = Math.min(entry.failures - this.#freeAttempts, 16);
      entry.lockedUntil = now + Math.min(this.#baseDelayMs * 2 ** exponent, this.#maxDelayMs);
    }
    this.#entries.set(key, entry);
    if (this.#entries.size > 10_000) this.#prune(now);
  }

  recordSuccess(key: string): void {
    this.#entries.delete(key);
  }

  #prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (now - entry.lastFailure > this.#forgetAfterMs) this.#entries.delete(key);
    }
  }
}
