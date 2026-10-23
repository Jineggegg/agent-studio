import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import {
  type Passkey,
  passkeyLoginRequestSchema,
  passkeyRegistrationRequestSchema,
  idSchema,
} from '@agent-studio/protocol';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isLoopbackHostname } from '../../kernel/config.js';
import { newId } from '../../kernel/crypto.js';
import type { Migration } from '../../kernel/database.js';
import { badRequest, conflict, notFound, unauthorized, unavailable } from '../../kernel/errors.js';
import type { ModuleContext } from '../../kernel/module.js';
import type { AuthService, StartedSession } from './auth.service.js';

export const PASSKEY_MIGRATION: Migration = {
  version: 3,
  name: 'passkeys',
  sql: `
    CREATE TABLE passkeys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_id TEXT NOT NULL UNIQUE,
      public_key BLOB NOT NULL,
      counter INTEGER NOT NULL,
      transports TEXT NOT NULL DEFAULT '[]',
      rp_id TEXT NOT NULL,
      name TEXT NOT NULL,
      backed_up INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX passkeys_user ON passkeys(user_id);
  `,
};

const CHALLENGE_TTL_MS = 60_000;
const MAX_PASSKEYS_PER_USER = 20;

interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string;
  rp_id: string;
  name: string;
  backed_up: number;
  created_at: number;
  last_used_at: number | null;
}

/**
 * Challenges are self-describing: random bytes, an expiry and a MAC over
 * both plus what the challenge is for. Asking for one therefore stores
 * nothing on the server — a flood of requests costs no memory — while a
 * challenge still cannot be forged, reused for another purpose or origin, or
 * used after 60 seconds. Only a *successfully used* challenge is remembered,
 * briefly, so that it cannot be replayed.
 */
class ChallengeIssuer {
  readonly #key: Buffer;
  readonly #used = new Map<string, number>();

  constructor(key: Buffer) {
    this.#key = key;
  }

  #mac(purpose: string, nonce: Buffer, expiry: Buffer): Buffer {
    return createHmac('sha256', this.#key)
      .update(purpose)
      .update('\0')
      .update(nonce)
      .update(expiry)
      .digest();
  }

  issue(purpose: string, now = Date.now()): Uint8Array<ArrayBuffer> {
    const nonce = randomBytes(16);
    const expiry = Buffer.alloc(8);
    expiry.writeBigUInt64BE(BigInt(now + CHALLENGE_TTL_MS));
    const bytes = Buffer.concat([nonce, expiry, this.#mac(purpose, nonce, expiry)]);
    const copy = new Uint8Array(new ArrayBuffer(bytes.length));
    copy.set(bytes);
    return copy;
  }

  /** Returns an atomic consume function when genuine, current and unused; otherwise null. */
  check(purpose: string, encoded: string, now = Date.now()): (() => boolean) | null {
    const bytes = Buffer.from(encoded, 'base64url');
    if (bytes.length !== 56) return null;
    const nonce = bytes.subarray(0, 16);
    const expiry = bytes.subarray(16, 24);
    const mac = bytes.subarray(24);
    if (!timingSafeEqual(mac, this.#mac(purpose, nonce, expiry))) return null;
    const expiresAt = Number(expiry.readBigUInt64BE());
    if (expiresAt < now) return null;
    const id = nonce.toString('hex');
    if (this.#used.has(id)) return null;
    return () => {
      // Verification awaits cryptography after check(). Another valid request
      // may have consumed this nonce in the meantime. Claim it only once, after
      // successful verification, so a bad signature cannot burn the challenge.
      const consumedAt = Date.now();
      if (expiresAt < consumedAt || this.#used.has(id)) return false;
      this.#used.set(id, consumedAt + CHALLENGE_TTL_MS);
      if (this.#used.size > 1000) {
        for (const [key, until] of this.#used) if (until < consumedAt) this.#used.delete(key);
      }
      return true;
    };
  }
}

const toPasskey = (row: PasskeyRow, currentRpId: string | null): Passkey => ({
  id: row.id,
  name: row.name,
  hostname: row.rp_id,
  usableHere: row.rp_id === currentRpId,
  syncedAcrossDevices: row.backed_up === 1,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

function describeDevice(userAgent: string | undefined): string {
  const agent = userAgent ?? '';
  const device = /iPhone/.test(agent)
    ? 'iPhone'
    : /iPad/.test(agent)
      ? 'iPad'
      : /Android/.test(agent)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(agent)
          ? 'Mac'
          : /Windows/.test(agent)
            ? 'Windows'
            : /Linux/.test(agent)
              ? 'Linux'
              : 'Device';
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Chrome\//.test(agent)
      ? 'Chrome'
      : /Firefox\//.test(agent)
        ? 'Firefox'
        : /Safari\//.test(agent)
          ? 'Safari'
          : '';
  return browser ? `${device} · ${browser}` : device;
}

/**
 * Passkeys (WebAuthn). A passkey is bound to the hostname it was created on,
 * so only named, secure entry points can use them: an https origin the
 * operator configured, or localhost. User verification (biometric or PIN) is
 * always required.
 */
export function setupPasskeys(
  context: ModuleContext,
  auth: AuthService,
  hooks: {
    signedIn(request: FastifyRequest, userId: string, session: StartedSession): unknown;
    clearSignInLock(username: string): void;
  },
): { availableFor(request: FastifyRequest): boolean } {
  const { http, db } = context;
  const audit = context.services.audit;
  const challenges = new ChallengeIssuer(context.keys.derive('passkey-challenges'));

  /** The relying-party id and origin for this request, or null when passkeys cannot work on this address. */
  const relyingParty = (request: FastifyRequest): { rpId: string; origin: string } | null => {
    const origin = http.originOf(request);
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return null;
    }
    const hostname = url.hostname;
    if (net.isIP(hostname.replace(/^\[|\]$/g, '')) !== 0) return null; // WebAuthn does not allow IP addresses
    const secure =
      url.protocol === 'https:' || (isLoopbackHostname(hostname) && hostname.endsWith('localhost'));
    return secure ? { rpId: hostname, origin } : null;
  };

  const requireRelyingParty = (request: FastifyRequest) => {
    const party = relyingParty(request);
    if (!party) {
      throw unavailable(
        'Passkeys need an https address with a host name (or localhost).',
        'passkeys_unavailable',
      );
    }
    return party;
  };

  http.route({
    method: 'GET',
    url: '/api/auth/passkeys',
    access: 'user',
    sessionOnly: true,
    handler: ({ user, request }) => {
      const party = relyingParty(request);
      return {
        available: party !== null,
        passkeys: db
          .all<PasskeyRow>(
            'SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at DESC',
            user.userId,
          )
          .map((row) => toPasskey(row, party?.rpId ?? null)),
      };
    },
  });

  http.route({
    method: 'POST',
    url: '/api/auth/passkeys/registration-options',
    access: 'user',
    sessionOnly: true,
    recentAuth: true,
    handler: async ({ user, request }) => {
      const party = requireRelyingParty(request);
      const existing = db.all<PasskeyRow>(
        'SELECT * FROM passkeys WHERE user_id = ? AND rp_id = ?',
        user.userId,
        party.rpId,
      );
      return generateRegistrationOptions({
        rpName: 'Cloud Harness',
        rpID: party.rpId,
        userName: user.username,
        userDisplayName: user.displayName,
        userID: new TextEncoder().encode(user.userId) as Uint8Array<ArrayBuffer>,
        challenge: challenges.issue(`register:${user.credentialId}:${party.rpId}`),
        timeout: CHALLENGE_TTL_MS,
        attestationType: 'none',
        excludeCredentials: existing.map((row) => ({
          id: row.credential_id,
          transports: JSON.parse(row.transports) as string[],
        })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
    },
  });

  http.route({
    method: 'POST',
    url: '/api/auth/passkeys/registration',
    access: 'user',
    sessionOnly: true,
    recentAuth: true,
    body: passkeyRegistrationRequestSchema,
    handler: async ({ user, body, request, reply }) => {
      const party = requireRelyingParty(request);
      const count = db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?',
        user.userId,
      )!.n;
      if (count >= MAX_PASSKEYS_PER_USER)
        throw conflict(
          'This account already has the maximum number of passkeys.',
          'too_many_passkeys',
        );

      let consume: (() => boolean) | null = null;
      const result = await verifyRegistrationResponse({
        response: body.response as unknown as Parameters<
          typeof verifyRegistrationResponse
        >[0]['response'],
        expectedChallenge: (challenge) =>
          (consume = challenges.check(`register:${user.credentialId}:${party.rpId}`, challenge)) !==
          null,
        expectedOrigin: party.origin,
        expectedRPID: party.rpId,
        requireUserVerification: true,
      }).catch(() => null);
      if (!result?.verified || !consume || !(consume as () => boolean)()) {
        throw badRequest(
          'That passkey could not be verified. Try again.',
          undefined,
          'passkey_rejected',
        );
      }
      const { credential, credentialBackedUp } = result.registrationInfo;
      const id = newId();
      try {
        db.run(
          `INSERT INTO passkeys (id, user_id, credential_id, public_key, counter, transports, rp_id, name, backed_up, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          user.userId,
          credential.id,
          Buffer.from(credential.publicKey),
          credential.counter,
          JSON.stringify(credential.transports ?? []),
          party.rpId,
          (body.name ?? describeDevice(request.headers['user-agent'])).slice(0, 80),
          credentialBackedUp ? 1 : 0,
          Date.now(),
        );
      } catch (error) {
        if (String((error as Error).message).includes('UNIQUE'))
          throw conflict('That passkey is already registered.', 'passkey_exists');
        throw error;
      }
      audit.record({
        category: 'change',
        action: 'passkey.added',
        userId: user.userId,
        subject: party.rpId,
        address: request.ip,
      });
      void reply.status(201);
      return toPasskey(db.get<PasskeyRow>('SELECT * FROM passkeys WHERE id = ?', id)!, party.rpId);
    },
  });

  http.route({
    method: 'DELETE',
    url: '/api/auth/passkeys/:id',
    access: 'user',
    sessionOnly: true,
    recentAuth: true,
    params: z.object({ id: idSchema }),
    handler: ({ user, params, request }) => {
      const removed =
        db.run('DELETE FROM passkeys WHERE id = ? AND user_id = ?', params.id, user.userId)
          .changes > 0;
      if (!removed) throw notFound('No such passkey.');
      audit.record({
        category: 'change',
        action: 'passkey.removed',
        userId: user.userId,
        address: request.ip,
      });
    },
  });

  // ---- signing in ----

  http.route({
    method: 'POST',
    url: '/api/auth/passkeys/login-options',
    access: 'public',
    bodyLimit: 1024,
    rateLimit: { max: context.config.env === 'test' ? 10_000 : 60, windowMs: 60_000 },
    handler: async ({ request }) => {
      const party = requireRelyingParty(request);
      // No account is named: the authenticator offers the passkeys it holds for this host.
      return generateAuthenticationOptions({
        rpID: party.rpId,
        challenge: challenges.issue(`login:${party.rpId}`),
        timeout: CHALLENGE_TTL_MS,
        userVerification: 'required',
      });
    },
  });

  http.route({
    method: 'POST',
    url: '/api/auth/passkeys/login',
    access: 'public',
    bodyLimit: 32 * 1024,
    body: passkeyLoginRequestSchema,
    rateLimit: { max: context.config.env === 'test' ? 10_000 : 30, windowMs: 60_000 },
    handler: async ({ body, request }) => {
      const party = requireRelyingParty(request);
      const refuse = () => {
        audit.record({
          category: 'failure',
          action: 'sign-in.passkey-refused',
          address: request.ip,
        });
        return unauthorized('That passkey was not accepted.', 'invalid_credentials');
      };
      const credentialId = (body.response as { id?: unknown }).id;
      if (typeof credentialId !== 'string') throw refuse();
      const row = db.get<PasskeyRow & { disabled: number; username: string }>(
        `SELECT p.*, u.disabled, u.username FROM passkeys p JOIN users u ON u.id = p.user_id WHERE p.credential_id = ? AND p.rp_id = ?`,
        credentialId,
        party.rpId,
      );
      if (!row || row.disabled === 1) throw refuse();

      let consume: (() => boolean) | null = null;
      const publicKey = new Uint8Array(new ArrayBuffer(row.public_key.length));
      publicKey.set(row.public_key);
      const result = await verifyAuthenticationResponse({
        response: body.response as unknown as Parameters<
          typeof verifyAuthenticationResponse
        >[0]['response'],
        expectedChallenge: (challenge) =>
          (consume = challenges.check(`login:${party.rpId}`, challenge)) !== null,
        expectedOrigin: party.origin,
        expectedRPID: party.rpId,
        credential: {
          id: row.credential_id,
          publicKey,
          counter: row.counter,
          transports: JSON.parse(row.transports) as string[],
        },
        requireUserVerification: true,
      }).catch(() => null);
      if (!result?.verified || !consume || !(consume as () => boolean)()) throw refuse();

      db.run(
        'UPDATE passkeys SET counter = ?, last_used_at = ?, backed_up = ? WHERE id = ?',
        result.authenticationInfo.newCounter,
        Date.now(),
        result.authenticationInfo.credentialBackedUp ? 1 : 0,
        row.id,
      );
      // A passkey works while password sign-in is locked, and lifts that lock.
      hooks.clearSignInLock(row.username);
      audit.record({
        category: 'sign-in',
        action: 'sign-in.passkey',
        userId: row.user_id,
        address: request.ip,
      });
      const session = auth.startSession(row.user_id, 'passkey', {
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
      });
      return hooks.signedIn(request, row.user_id, session);
    },
  });

  return { availableFor: (request) => relyingParty(request) !== null };
}
