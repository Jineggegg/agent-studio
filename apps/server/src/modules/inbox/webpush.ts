import {
  createCipheriv,
  createECDH,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  type KeyObject,
} from 'node:crypto';
import { badRequest } from '../../kernel/errors.js';
import { type NetPolicy, guardedRequest, readBody } from '../../kernel/net.js';

/**
 * Web Push, implemented against the standards with the standard library:
 * message encryption (RFC 8291, "aes128gcm" content coding of RFC 8188) and
 * application-server identification (VAPID, RFC 8292).
 *
 * Push services only ever see ciphertext. The endpoint URL comes from the
 * browser, so requests go through the guarded HTTP client and only to the
 * push services browsers actually use.
 */

export interface PushSubscription {
  readonly endpoint: string;
  /** The browser's P-256 public key, uncompressed point, base64url. */
  readonly p256dh: string;
  /** The 16-byte authentication secret, base64url. */
  readonly auth: string;
}

export interface VapidKeys {
  /** Uncompressed P-256 public point, base64url — what a browser needs as `applicationServerKey`. */
  readonly publicKey: string;
  /** The private scalar, base64url. Keep it in the secret store. */
  readonly privateKey: string;
}

export type PushOutcome =
  | { readonly status: 'sent' }
  /** The push service says this subscription no longer exists: forget it. */
  | { readonly status: 'gone' }
  | { readonly status: 'rejected'; readonly httpStatus: number; readonly retryAfterSeconds?: number }
  | { readonly status: 'unreachable'; readonly reason: string };

/** Host names (exact or as a suffix after a dot) of the push services of current browsers. */
export const PUSH_SERVICE_HOSTS: readonly string[] = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
];

const RECORD_SIZE = 4096;
/** Largest plaintext that fits one record: record size − tag (16) − padding delimiter (1). */
export const MAX_PUSH_PAYLOAD_BYTES = RECORD_SIZE - 16 - 1 - 86;

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64url');

export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]);
  return { publicKey: b64(point), privateKey: jwk.d! };
}

function vapidPrivateKey(keys: VapidKeys): KeyObject {
  const point = Buffer.from(keys.publicKey, 'base64url');
  return createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64(point.subarray(1, 33)), y: b64(point.subarray(33, 65)) },
  });
}

/**
 * Checks a subscription's shape and that its endpoint is a push service we are willing to contact.
 *
 * `policy` exists for tests that put a stand-in push service on this machine:
 * `allowHttp` accepts a plain-http endpoint. Production callers leave it out,
 * and then only https endpoints of the listed services pass.
 */
export function validateSubscription(
  subscription: PushSubscription,
  allowedHosts: readonly string[] = PUSH_SERVICE_HOSTS,
  policy: NetPolicy = {},
): URL {
  let url: URL;
  try {
    url = new URL(subscription.endpoint);
  } catch {
    throw badRequest('That push subscription is not valid.', undefined, 'invalid_subscription');
  }
  const host = url.hostname.toLowerCase();
  const known = allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  const schemeAccepted = url.protocol === 'https:' || (url.protocol === 'http:' && policy.allowHttp === true);
  if (!schemeAccepted || url.username || url.password || !known) {
    throw badRequest('That browser\'s push service is not supported.', undefined, 'unsupported_push_service');
  }
  if (Buffer.from(subscription.p256dh, 'base64url').length !== 65 || Buffer.from(subscription.auth, 'base64url').length !== 16) {
    throw badRequest('That push subscription is not valid.', undefined, 'invalid_subscription');
  }
  return url;
}

/**
 * Encrypts `plaintext` for one subscription. `ephemeral` exists so the
 * published test vector of RFC 8291 can be reproduced; production callers
 * omit it and get a fresh key pair and salt per message.
 */
export function encryptPayload(
  subscription: Pick<PushSubscription, 'p256dh' | 'auth'>,
  plaintext: Uint8Array,
  ephemeral?: { readonly privateKey: Uint8Array; readonly salt: Uint8Array },
): Buffer {
  if (plaintext.length > MAX_PUSH_PAYLOAD_BYTES) throw new Error('The push payload is too large for one record.');
  const clientPublic = Buffer.from(subscription.p256dh, 'base64url');
  const authSecret = Buffer.from(subscription.auth, 'base64url');

  const ecdh = createECDH('prime256v1');
  if (ephemeral) ecdh.setPrivateKey(Buffer.from(ephemeral.privateKey));
  else ecdh.generateKeys();
  const serverPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(clientPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), clientPublic, serverPublic]);
  const inputKey = Buffer.from(hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32));

  const salt = ephemeral ? Buffer.from(ephemeral.salt) : randomBytes(16);
  const contentKey = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const cipher = createCipheriv('aes-128-gcm', contentKey, nonce);
  // 0x02 marks the last (here: only) record; no further padding.
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(16 + 4 + 1);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(serverPublic.length, 20);
  return Buffer.concat([header, serverPublic, ciphertext]);
}

/** The VAPID `Authorization` header value for a push service origin. */
export function vapidAuthorization(keys: VapidKeys, audience: string, subject: string, now = Date.now()): string {
  const header = b64(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: subject })));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: vapidPrivateKey(keys), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64(signature)}, k=${keys.publicKey}`;
}

export interface PushMessage {
  /** JSON-serialisable; the service worker receives exactly this. Keep it small. */
  readonly payload: unknown;
  /** How long the push service may hold the message for an offline device. */
  readonly ttlSeconds?: number;
  readonly urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** Messages with the same topic replace each other while undelivered (≤ 32 URL-safe characters). */
  readonly topic?: string;
}

export interface PushSendOptions {
  /** Push services that may be contacted. Defaults to {@link PUSH_SERVICE_HOSTS}. */
  readonly allowedHosts?: readonly string[];
  readonly timeoutMs?: number;
  /**
   * For tests only: lets a stand-in push service on this machine be reached
   * (plain http, a loopback address). Left out — as every production caller
   * must — the request goes to a public address over https or not at all.
   */
  readonly policy?: NetPolicy;
}

/** The topic a message is sent under so that it replaces an undelivered one with the same key: at most 32 URL-safe characters. */
export function pushTopic(key: string): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 32);
}

export async function sendPush(
  subscription: PushSubscription,
  message: PushMessage,
  vapid: { readonly keys: VapidKeys; readonly subject: string },
  options: PushSendOptions = {},
): Promise<PushOutcome> {
  const url = validateSubscription(subscription, options.allowedHosts, options.policy);
  const body = encryptPayload(subscription, Buffer.from(JSON.stringify(message.payload), 'utf8'));
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-encoding': 'aes128gcm',
    'content-length': String(body.length),
    ttl: String(message.ttlSeconds ?? 24 * 60 * 60),
    urgency: message.urgency ?? 'normal',
    authorization: vapidAuthorization(vapid.keys, url.origin, vapid.subject),
  };
  if (message.topic && /^[A-Za-z0-9_-]{1,32}$/.test(message.topic)) headers.topic = message.topic;

  try {
    const response = await guardedRequest(url.toString(), {
      method: 'POST',
      headers,
      body,
      timeoutMs: options.timeoutMs ?? 15_000,
      ...(options.policy ? { policy: options.policy } : {}),
    });
    await readBody(response.body, 64 * 1024).catch(() => undefined);
    if (response.status >= 200 && response.status < 300) return { status: 'sent' };
    if (response.status === 404 || response.status === 410) return { status: 'gone' };
    const retryAfter = Number(response.headers['retry-after']);
    return {
      status: 'rejected',
      httpStatus: response.status,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
    };
  } catch (error) {
    return { status: 'unreachable', reason: error instanceof Error ? error.message : 'unknown error' };
  }
}
