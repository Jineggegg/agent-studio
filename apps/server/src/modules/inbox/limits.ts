/**
 * Two small in-memory guards against notification storms. Both take the clock
 * as a function, so tests never wait for real time, and both forget
 * everything on restart — which errs on the side of telling the user.
 */

/** Lets a key through once per window. */
export class DedupeWindow {
  readonly #seen = new Map<string, number>();
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #capacity: number;

  constructor(windowMs: number, now: () => number, capacity = 5000) {
    this.#windowMs = windowMs;
    this.#now = now;
    this.#capacity = capacity;
  }

  /** True the first time a key is seen within the window; false for a repeat. A repeat does not extend the window. */
  admit(key: string): boolean {
    const now = this.#now();
    const until = this.#seen.get(key);
    if (until !== undefined && now < until) return false;
    // Re-inserting moves the key to the end, so the oldest entries are always first.
    this.#seen.delete(key);
    this.#seen.set(key, now + this.#windowMs);
    if (this.#seen.size > this.#capacity) this.#prune(now);
    return true;
  }

  #prune(now: number): void {
    for (const [key, until] of this.#seen) {
      if (until <= now || this.#seen.size > this.#capacity) this.#seen.delete(key);
      else break;
    }
  }

  get size(): number {
    return this.#seen.size;
  }
}

/** At most `limit` events per key within any `windowMs`. What does not fit is refused, never queued. */
export class SlidingRate {
  readonly #stamps = new Map<string, number[]>();
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;

  constructor(limit: number, windowMs: number, now: () => number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  #current(key: string, now: number): number[] {
    const stamps = (this.#stamps.get(key) ?? []).filter((at) => now - at < this.#windowMs);
    if (stamps.length === 0) this.#stamps.delete(key);
    else this.#stamps.set(key, stamps);
    return stamps;
  }

  /** Milliseconds until one more event would fit; 0 when it fits now. */
  waitMs(key: string): number {
    const now = this.#now();
    const stamps = this.#current(key, now);
    if (stamps.length < this.#limit) return 0;
    return Math.max(1, stamps[stamps.length - this.#limit]! + this.#windowMs - now);
  }

  /** Records one event. False — and nothing recorded — when the limit is reached. */
  take(key: string): boolean {
    const now = this.#now();
    const stamps = this.#current(key, now);
    if (stamps.length >= this.#limit) return false;
    stamps.push(now);
    this.#stamps.set(key, stamps);
    if (this.#stamps.size > 10_000) {
      for (const other of [...this.#stamps.keys()]) this.#current(other, now);
    }
    return true;
  }
}
