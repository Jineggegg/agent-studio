import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { ApiToken, DeviceSession, Role, SignInMethod, TokenScope, User } from '@agent-studio/protocol';
import type { StudioConfig } from '../../kernel/config.js';
import { hashPassword, hmacSha256, newId, randomToken, safeEqual, sha256, verifyPassword } from '../../kernel/crypto.js';
import type { Database, Migration } from '../../kernel/database.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../../kernel/errors.js';
import type { EventBus } from '../../kernel/events.js';
import type { Authenticator, Principal, RequestMeta } from '../../kernel/principal.js';
import type { KeyRing } from '../../kernel/secrets.js';
import { PASSKEY_MIGRATION } from './passkeys.js';

export const AUTH_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'users, sessions, api tokens',
    sql: `
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        password_hash TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE auth_sessions (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        method TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        authenticated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        user_agent TEXT,
        ip TEXT
      );
      CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
      CREATE TABLE api_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        scopes TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER,
        expires_at INTEGER
      );
      CREATE INDEX api_tokens_user ON api_tokens(user_id);
    `,
  },
  {
    version: 2,
    name: 'persistent attempt throttle',
    sql: `
      CREATE TABLE auth_throttle (
        key TEXT PRIMARY KEY,
        failures INTEGER NOT NULL,
        locked_until INTEGER NOT NULL,
        last_failure INTEGER NOT NULL
      );
    `,
  },
  PASSKEY_MIGRATION,
];

const DAY_MS = 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60_000;
export const API_TOKEN_PREFIX = 'ast_';

/** Passwords everyone tries first. A real breach-list check belongs in front of this, not instead of it. */
const COMMON_PASSWORDS = new Set([
  'password1234', 'password12345', '123456789012', '1234567890123', 'qwertyuiop12', 'qwertyuiopas', 'qwerty123456',
  'iloveyou1234', 'administrator', 'letmein12345', 'welcome12345', 'changeme1234', 'adminadminadmin', 'adminadmin12',
  'passwordpassword', '012345678901', '1q2w3e4r5t6y', 'abcdefghijkl', 'abc123456789', 'password!123',
]);

interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  password_hash: string;
  disabled: number;
  created_at: number;
}

interface SessionRow {
  id: string;
  user_id: string;
  method: SignInMethod;
  created_at: number;
  last_seen_at: number;
  authenticated_at: number;
  expires_at: number;
  user_agent: string | null;
  ip: string | null;
}

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  scopes: string;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
}

const toUser = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  role: row.role,
  disabled: row.disabled === 1,
  createdAt: row.created_at,
});

const toToken = (row: TokenRow): ApiToken => ({
  id: row.id,
  name: row.name,
  scopes: JSON.parse(row.scopes) as TokenScope[],
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  expiresAt: row.expires_at,
});

const scopesFor = (role: Role): TokenScope[] => (role === 'owner' ? ['read', 'write', 'admin'] : ['read', 'write']);

export interface StartedSession {
  readonly token: string;
  readonly sessionId: string;
  readonly expiresAt: number;
}

export class AuthService implements Authenticator {
  readonly #db: Database;
  readonly #bus: EventBus;
  readonly #config: StudioConfig;
  readonly #csrfKey: Buffer;
  readonly #setupTokenFile: string;
  #setupToken: string | null = null;
  #dummyHash: Promise<string> | null = null;

  constructor(deps: { db: Database; bus: EventBus; config: StudioConfig; keys: KeyRing }) {
    this.#db = deps.db;
    this.#bus = deps.bus;
    this.#config = deps.config;
    this.#csrfKey = deps.keys.derive('csrf');
    this.#setupTokenFile = path.join(deps.config.dataDir, 'setup-token');
    if (this.needsSetup()) {
      this.#setupToken = deps.config.setupToken ?? randomToken(18);
      writeFileSync(this.#setupTokenFile, this.#setupToken + '\n', { mode: 0o600 });
    } else if (existsSync(this.#setupTokenFile)) {
      rmSync(this.#setupTokenFile, { force: true });
    }
  }

  // ---- first run -----------------------------------------------------------

  needsSetup(): boolean {
    return this.#db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n === 0;
  }

  /** The one-time token an operator needs to create the first account; null once that is done. */
  pendingSetupToken(): { token: string; file: string } | null {
    return this.#setupToken ? { token: this.#setupToken, file: this.#setupTokenFile } : null;
  }

  async setup(input: { setupToken: string; username: string; password: string; displayName?: string }): Promise<User> {
    if (!this.#setupToken || !this.needsSetup()) {
      throw conflict('This Studio is already set up.', 'already_set_up');
    }
    if (!safeEqual(input.setupToken, this.#setupToken)) {
      throw forbidden('That setup token is not correct.', 'invalid_setup_token');
    }
    const user = await this.createUser({ ...input, role: 'owner' });
    this.#setupToken = null;
    rmSync(this.#setupTokenFile, { force: true });
    return user;
  }

  // ---- users ---------------------------------------------------------------

  #assertPasswordAcceptable(password: string, username: string): void {
    const lower = password.toLowerCase();
    if (COMMON_PASSWORDS.has(lower) || lower === username.toLowerCase() || /^(.)\1+$/.test(password)) {
      throw badRequest('That password is too easy to guess. Choose another.', undefined, 'weak_password');
    }
  }

  async createUser(input: { username: string; password: string; displayName?: string; role: Role }): Promise<User> {
    this.#assertPasswordAcceptable(input.password, input.username);
    const passwordHash = await hashPassword(input.password);
    const now = Date.now();
    const id = newId();
    try {
      this.#db.run(
        `INSERT INTO users (id, username, display_name, role, password_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id,
        input.username,
        input.displayName ?? input.username,
        input.role,
        passwordHash,
        now,
        now,
      );
    } catch (error) {
      if (String((error as Error).message).includes('UNIQUE')) {
        throw conflict('That username is taken.', 'username_taken');
      }
      throw error;
    }
    return this.getUser(id);
  }

  #userRow(id: string): UserRow | undefined {
    return this.#db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  }

  getUser(id: string): User {
    const row = this.#userRow(id);
    if (!row) throw notFound('No such user.');
    return toUser(row);
  }

  findUser(id: string): User | null {
    const row = this.#userRow(id);
    return row ? toUser(row) : null;
  }

  listUsers(): User[] {
    return this.#db.all<UserRow>('SELECT * FROM users ORDER BY created_at').map(toUser);
  }

  #activeOwnerCount(excludingId?: string): number {
    return this.#db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled = 0 AND id != ?`,
      excludingId ?? '',
    )!.n;
  }

  async updateUser(
    id: string,
    changes: { displayName?: string; role?: Role; disabled?: boolean; password?: string },
    actor: Principal,
  ): Promise<User> {
    const row = this.#userRow(id);
    if (!row) throw notFound('No such user.');
    const losesOwnership =
      row.role === 'owner' && row.disabled === 0 && (changes.role === 'member' || changes.disabled === true);
    if (losesOwnership && this.#activeOwnerCount(id) === 0) {
      throw conflict('A Studio needs at least one active owner.', 'last_owner');
    }
    if (changes.disabled === true && id === actor.userId) {
      throw conflict('You cannot disable your own account.', 'cannot_disable_self');
    }
    let passwordHash: string | null = null;
    if (changes.password !== undefined) {
      this.#assertPasswordAcceptable(changes.password, row.username);
      passwordHash = await hashPassword(changes.password);
    }
    this.#db.run(
      `UPDATE users SET
         display_name = COALESCE(?, display_name),
         role = COALESCE(?, role),
         disabled = COALESCE(?, disabled),
         password_hash = COALESCE(?, password_hash),
         updated_at = ?
       WHERE id = ?`,
      changes.displayName ?? null,
      changes.role ?? null,
      changes.disabled === undefined ? null : changes.disabled ? 1 : 0,
      passwordHash,
      Date.now(),
      id,
    );
    // Anything that changes what the account may do, or who knows its password,
    // ends its existing sessions and tokens.
    if (changes.disabled === true || changes.role !== undefined || passwordHash !== null) {
      this.revokeAllCredentials(id);
    }
    return this.getUser(id);
  }

  deleteUser(id: string, actor: Principal): void {
    const row = this.#userRow(id);
    if (!row) throw notFound('No such user.');
    if (id === actor.userId) throw conflict('You cannot delete your own account.', 'cannot_delete_self');
    if (row.role === 'owner' && this.#activeOwnerCount(id) === 0) {
      throw conflict('A Studio needs at least one active owner.', 'last_owner');
    }
    this.#db.run('DELETE FROM users WHERE id = ?', id);
    this.#bus.publish('internal:auth', 'auth.user.revoked', { userId: id });
    this.#bus.publish('internal:auth', 'auth.user.deleted', { userId: id });
  }

  // ---- credentials ---------------------------------------------------------

  /** Checks a password. Takes the same time whether or not the account exists. */
  async verifyCredentials(username: string, password: string): Promise<User | null> {
    const row = this.#db.get<UserRow>('SELECT * FROM users WHERE username = ?', username);
    if (!row) {
      this.#dummyHash ??= hashPassword(randomToken(16));
      await verifyPassword(password, await this.#dummyHash);
      return null;
    }
    const ok = await verifyPassword(password, row.password_hash);
    return ok && row.disabled === 0 ? toUser(row) : null;
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string, keepSessionId: string): Promise<void> {
    const row = this.#userRow(userId);
    if (!row) throw notFound('No such user.');
    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      throw unauthorized('Your current password is not correct.', 'invalid_credentials');
    }
    this.#assertPasswordAcceptable(newPassword, row.username);
    this.#db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(newPassword), Date.now(), userId);
    this.revokeAllCredentials(userId, keepSessionId);
  }

  // ---- browser sessions ----------------------------------------------------

  startSession(userId: string, method: SignInMethod, meta: RequestMeta): StartedSession {
    const token = randomToken(32);
    const now = Date.now();
    const sessionId = newId();
    const expiresAt = now + this.#config.sessionMaxDays * DAY_MS;
    this.#db.run(
      `INSERT INTO auth_sessions (id, token_hash, user_id, method, created_at, last_seen_at, authenticated_at, expires_at, user_agent, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      sha256(token),
      userId,
      method,
      now,
      now,
      now,
      expiresAt,
      meta.userAgent?.slice(0, 300) ?? null,
      meta.ip,
    );
    return { token, sessionId, expiresAt };
  }

  csrfTokenFor(sessionId: string): string {
    return hmacSha256(this.#csrfKey, sessionId);
  }

  #sessionIsCurrent(row: { last_seen_at: number; expires_at: number }, now: number): boolean {
    return now < row.expires_at && now - row.last_seen_at < this.#config.sessionIdleDays * DAY_MS;
  }

  fromSessionCookie(token: string, _meta: RequestMeta): Principal | null {
    if (token.length < 20 || token.length > 200) return null;
    const row = this.#db.get<SessionRow & UserRow & { session_id: string }>(
      `SELECT s.id AS session_id, s.user_id, s.method, s.last_seen_at, s.authenticated_at, s.expires_at,
              u.username, u.display_name, u.role, u.disabled
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ?`,
      sha256(token),
    );
    if (!row) return null;
    const now = Date.now();
    if (row.disabled === 1 || !this.#sessionIsCurrent(row, now)) {
      this.#db.run('DELETE FROM auth_sessions WHERE id = ?', row.session_id);
      return null;
    }
    if (now - row.last_seen_at > TOUCH_INTERVAL_MS) {
      this.#db.run('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?', now, row.session_id);
    }
    return {
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      via: 'session',
      credentialId: row.session_id,
      scopes: scopesFor(row.role),
      authenticatedAt: row.authenticated_at,
      csrfToken: this.csrfTokenFor(row.session_id),
    };
  }

  describeSession(sessionId: string): SessionRow | null {
    return this.#db.get<SessionRow>('SELECT * FROM auth_sessions WHERE id = ?', sessionId) ?? null;
  }

  markReauthenticated(sessionId: string): void {
    this.#db.run('UPDATE auth_sessions SET authenticated_at = ? WHERE id = ?', Date.now(), sessionId);
  }

  listSessions(userId: string, currentSessionId: string | null): DeviceSession[] {
    const now = Date.now();
    return this.#db
      .all<SessionRow>('SELECT * FROM auth_sessions WHERE user_id = ? ORDER BY last_seen_at DESC', userId)
      .filter((row) => this.#sessionIsCurrent(row, now))
      .map((row) => ({
        id: row.id,
        current: row.id === currentSessionId,
        method: row.method,
        createdAt: row.created_at,
        lastSeenAt: row.last_seen_at,
        expiresAt: row.expires_at,
        userAgent: row.user_agent,
        ip: row.ip,
      }));
  }

  endSession(userId: string, sessionId: string): boolean {
    const removed = this.#db.run('DELETE FROM auth_sessions WHERE id = ? AND user_id = ?', sessionId, userId).changes > 0;
    if (removed) this.#bus.publish('internal:auth', 'auth.credential.revoked', { credentialId: sessionId });
    return removed;
  }

  /** Signs the account out everywhere and cancels its API tokens, optionally sparing one session. */
  revokeAllCredentials(userId: string, keepSessionId?: string): void {
    const sessions = this.#db.all<{ id: string }>('SELECT id FROM auth_sessions WHERE user_id = ? AND id != ?', userId, keepSessionId ?? '');
    const tokens = this.#db.all<{ id: string }>('SELECT id FROM api_tokens WHERE user_id = ?', userId);
    this.#db.run('DELETE FROM auth_sessions WHERE user_id = ? AND id != ?', userId, keepSessionId ?? '');
    this.#db.run('DELETE FROM api_tokens WHERE user_id = ?', userId);
    for (const { id } of [...sessions, ...tokens]) {
      this.#bus.publish('internal:auth', 'auth.credential.revoked', { credentialId: id });
    }
  }

  /** Housekeeping: forget sessions and tokens that can no longer be used. */
  purgeExpired(now = Date.now()): number {
    const idle = now - this.#config.sessionIdleDays * DAY_MS;
    const sessions = this.#db.run('DELETE FROM auth_sessions WHERE expires_at <= ? OR last_seen_at <= ?', now, idle).changes;
    const tokens = this.#db.run('DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?', now).changes;
    return sessions + tokens;
  }

  // ---- API tokens ----------------------------------------------------------

  createApiToken(user: Principal, input: { name: string; scopes: TokenScope[]; expiresInDays?: number }): { token: string; record: ApiToken } {
    const allowed = scopesFor(user.role);
    const scopes = [...new Set(input.scopes)];
    if (scopes.some((scope) => !allowed.includes(scope))) {
      throw forbidden('You cannot grant a scope you do not have yourself.', 'insufficient_scope');
    }
    const token = API_TOKEN_PREFIX + randomToken(32);
    const now = Date.now();
    const id = newId();
    const expiresAt = input.expiresInDays === undefined ? null : now + input.expiresInDays * DAY_MS;
    this.#db.run(
      'INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      user.userId,
      input.name,
      sha256(token),
      JSON.stringify(scopes),
      now,
      expiresAt,
    );
    return { token, record: { id, name: input.name, scopes, createdAt: now, lastUsedAt: null, expiresAt } };
  }

  listApiTokens(userId: string): ApiToken[] {
    return this.#db.all<TokenRow>('SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC', userId).map(toToken);
  }

  revokeApiToken(userId: string, tokenId: string): boolean {
    const removed = this.#db.run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', tokenId, userId).changes > 0;
    if (removed) this.#bus.publish('internal:auth', 'auth.credential.revoked', { credentialId: tokenId });
    return removed;
  }

  fromBearerToken(token: string, _meta: RequestMeta): Principal | null {
    if (!token.startsWith(API_TOKEN_PREFIX) || token.length > 200) return null;
    const row = this.#db.get<TokenRow & UserRow & { token_id: string }>(
      `SELECT t.id AS token_id, t.user_id, t.scopes, t.expires_at, t.last_used_at,
              u.username, u.display_name, u.role, u.disabled
       FROM api_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?`,
      sha256(token),
    );
    if (!row || row.disabled === 1) return null;
    const now = Date.now();
    if (row.expires_at !== null && row.expires_at <= now) return null;
    if (row.last_used_at === null || now - row.last_used_at > TOUCH_INTERVAL_MS) {
      this.#db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now, row.token_id);
    }
    const roleScopes = scopesFor(row.role);
    return {
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      via: 'token',
      credentialId: row.token_id,
      scopes: (JSON.parse(row.scopes) as TokenScope[]).filter((scope) => roleScopes.includes(scope)),
      // A token never counts as a fresh proof of identity.
      authenticatedAt: 0,
    };
  }

  isCredentialLive(principal: Principal): boolean {
    const now = Date.now();
    if (principal.via === 'session') {
      const row = this.#db.get<{ last_seen_at: number; expires_at: number; disabled: number }>(
        `SELECT s.last_seen_at, s.expires_at, u.disabled FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
        principal.credentialId,
      );
      return row !== undefined && row.disabled === 0 && this.#sessionIsCurrent(row, now);
    }
    const row = this.#db.get<{ expires_at: number | null; disabled: number }>(
      `SELECT t.expires_at, u.disabled FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.id = ?`,
      principal.credentialId,
    );
    return row !== undefined && row.disabled === 0 && (row.expires_at === null || row.expires_at > now);
  }
}
