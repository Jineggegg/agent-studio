import { hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { StudioConfig } from './config.js';
import { SecretBox } from './crypto.js';
import type { Database } from './database.js';
import { SECRET_HINT, secretHint } from './redact.js';

/** Creates the data directory for the owner only, and tightens it if it already exists. */
export function prepareDataDir(dataDir: string): void {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(dataDir, 0o700);
}

/**
 * The key that protects stored credentials. It comes from the environment
 * when the operator supplies one (so it can live in a secret manager), and
 * otherwise from an owner-only file created next to the database.
 */
export function loadMasterKey(config: Pick<StudioConfig, 'masterKey' | 'dataDir'>): Buffer {
  if (config.masterKey) return Buffer.from(config.masterKey, 'base64');
  const file = path.join(config.dataDir, 'master.key');
  try {
    // Created only if absent ("wx"): an existing key is never replaced.
    writeFileSync(file, randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error(`${file} does not contain a 32-byte key.`);
  return key;
}

/** Derives independent keys for independent purposes from the one master key. */
export class KeyRing {
  readonly #master: Buffer;

  constructor(master: Buffer) {
    this.#master = master;
  }

  derive(purpose: string): Buffer {
    return Buffer.from(hkdfSync('sha256', this.#master, Buffer.alloc(0), `agent-studio:${purpose}`, 32));
  }
}

export interface SecretDescription {
  readonly name: string;
  /** A fixed marker that a value is saved. It holds no character of the secret. */
  readonly hint: string;
  readonly updatedAt: number;
}

export const SECRETS_MIGRATIONS = [
  {
    version: 1,
    name: 'secrets',
    sql: `
      CREATE TABLE secrets (
        name TEXT PRIMARY KEY,
        sealed TEXT NOT NULL,
        hint TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    // Earlier versions kept the last four characters of each secret in `hint`.
    // No part of a secret is kept in the clear any more: overwrite what is there.
    version: 2,
    name: 'secret hints reveal nothing',
    sql: `UPDATE secrets SET hint = '${SECRET_HINT}';`,
  },
] as const;

/**
 * Credentials the server needs to act for the user (model API keys and the
 * like), encrypted at rest. Plaintext leaves this class only through `reveal`,
 * which is for server-side use; nothing in the HTTP API returns it.
 */
export class SecretStore {
  readonly #db: Database;
  readonly #box: SecretBox;

  constructor(db: Database, keys: KeyRing) {
    this.#db = db;
    this.#box = new SecretBox(keys.derive('secret-store'));
  }

  put(name: string, value: string): SecretDescription {
    const updatedAt = Date.now();
    const hint = secretHint();
    this.#db.run(
      `INSERT INTO secrets (name, sealed, hint, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET sealed = excluded.sealed, hint = excluded.hint, updated_at = excluded.updated_at`,
      name,
      this.#box.seal(value, name),
      hint,
      updatedAt,
    );
    return { name, hint, updatedAt };
  }

  reveal(name: string): string | null {
    const row = this.#db.get<{ sealed: string }>('SELECT sealed FROM secrets WHERE name = ?', name);
    return row ? this.#box.open(row.sealed, name) : null;
  }

  describe(name: string): SecretDescription | null {
    const row = this.#db.get<{ name: string; updated_at: number }>(
      'SELECT name, updated_at FROM secrets WHERE name = ?',
      name,
    );
    // The marker, not the stored column: whatever a row holds, a description reveals nothing of the value.
    return row ? { name: row.name, hint: secretHint(), updatedAt: row.updated_at } : null;
  }

  delete(name: string): boolean {
    return this.#db.run('DELETE FROM secrets WHERE name = ?', name).changes > 0;
  }
}
