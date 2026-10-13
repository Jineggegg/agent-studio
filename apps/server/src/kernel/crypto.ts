import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';

/** URL-safe random token with `bytes` of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Sortable unique id: milliseconds since epoch + randomness, 26 base32 characters. */
export function newId(): string {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let time = Date.now();
  let head = '';
  for (let i = 0; i < 10; i += 1) {
    head = alphabet[time % 32] + head;
    time = Math.floor(time / 32);
  }
  const random = randomBytes(16);
  let tail = '';
  for (let i = 0; i < 16; i += 1) tail += alphabet[random[i]! % 32];
  return head + tail;
}

export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256(key: string | Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('base64url');
}

/** Constant-time string comparison that does not leak the length difference through timing. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest();
  const right = createHash('sha256').update(b).digest();
  return timingSafeEqual(left, right);
}

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, length: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      password.normalize('NFKC'),
      salt,
      length,
      { N, r, p, maxmem: 256 * N * r },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** scrypt with a per-password salt; the parameters travel with the hash so they can be raised later. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltLength);
  const key = await scrypt(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLength);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N > 1 << 20) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  const actual = await scrypt(password, salt, N, r, p, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Authenticated encryption for secrets at rest (AES-256-GCM). The associated
 * data binds a ciphertext to the record it was written for, so a value copied
 * to another row fails to open.
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('SecretBox needs a 32-byte key.');
    this.#key = key;
  }

  seal(plaintext: string, associatedData: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', nonce.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
  }

  open(sealed: string, associatedData: string): string {
    const parts = sealed.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unrecognised secret format.');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(parts[1]!, 'base64url'));
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(Buffer.from(parts[3]!, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[2]!, 'base64url')), decipher.final()]).toString('utf8');
  }
}
