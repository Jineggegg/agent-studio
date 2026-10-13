import type { PluginPanelSlot } from '@agent-studio/protocol';
import { randomToken, sha256 } from '../../kernel/crypto.js';

/**
 * Panel grants.
 *
 * A panel runs in a frame with an opaque origin, so the requests it makes for
 * its own scripts and styles carry no session cookie (and the route would not
 * look at one). What lets those requests through instead is a grant: a long random value in the address, minted by
 * an authenticated request, bound to one plugin, one panel, one user and at
 * most one project, valid for about an hour, and gone when that user signs
 * out or the plugin is disabled.
 *
 * A grant opens the panel's static files and names the panel in panel calls.
 * It is never enough to *make* a panel call — that also takes the user's
 * session — so a grant that leaks (it is part of an address) gives away files
 * of an installed plugin and nothing else.
 */

export interface PanelGrant {
  readonly pluginId: string;
  readonly panelId: string;
  readonly slot: PluginPanelSlot;
  readonly userId: string;
  /** The session that minted it; ending that session ends the grant. */
  readonly credentialId: string;
  readonly projectId: string | null;
  /** Folder the panel's files are served from. */
  readonly assetRoot: string;
  /** File name of the panel's page inside `assetRoot`. */
  readonly entryFile: string;
  readonly expiresAt: number;
}

export interface GrantStoreOptions {
  readonly ttlMs: number;
  readonly maxPerUser: number;
  readonly maxTotal: number;
  readonly now?: () => number;
}

export class PanelGrantStore {
  // Keyed by a hash of the token: a dump of this map does not hand out working grants.
  readonly #grants = new Map<string, PanelGrant>();
  readonly #options: GrantStoreOptions;
  readonly #now: () => number;

  constructor(options: GrantStoreOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.#grants.size;
  }

  mint(binding: Omit<PanelGrant, 'expiresAt'>): { token: string; grant: PanelGrant } {
    this.sweep();
    const mine = [...this.#grants.entries()].filter(([, grant]) => grant.userId === binding.userId);
    // Oldest first: a Map keeps insertion order.
    for (const [key] of mine.slice(0, Math.max(0, mine.length - this.#options.maxPerUser + 1))) this.#grants.delete(key);
    while (this.#grants.size >= this.#options.maxTotal) {
      const oldest = this.#grants.keys().next();
      if (oldest.done) break;
      this.#grants.delete(oldest.value);
    }
    const token = randomToken(32);
    const grant: PanelGrant = { ...binding, expiresAt: this.#now() + this.#options.ttlMs };
    this.#grants.set(sha256(token), grant);
    return { token, grant };
  }

  /** The grant a token stands for, or null when it is unknown, malformed or expired. */
  resolve(token: unknown): PanelGrant | null {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
    const key = sha256(token);
    const grant = this.#grants.get(key);
    if (!grant) return null;
    if (grant.expiresAt <= this.#now()) {
      this.#grants.delete(key);
      return null;
    }
    return grant;
  }

  /** Removes every grant the predicate picks; returns how many. */
  revoke(predicate: (grant: PanelGrant) => boolean): number {
    let removed = 0;
    for (const [key, grant] of this.#grants) {
      if (predicate(grant)) {
        this.#grants.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  sweep(): void {
    const now = this.#now();
    this.revoke((grant) => grant.expiresAt <= now);
  }
}
