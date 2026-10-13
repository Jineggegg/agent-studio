import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * A software WebAuthn authenticator for tests: it creates real key pairs and
 * produces the same structures a browser would hand to the server, so the
 * server's verification is exercised for real.
 */

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const buffer = Buffer.alloc(3);
    buffer[0] = (major << 5) | 25;
    buffer.writeUInt16BE(value, 1);
    return buffer;
  }
  const buffer = Buffer.alloc(5);
  buffer[0] = (major << 5) | 26;
  buffer.writeUInt32BE(value, 1);
  return buffer;
}

export function encodeCbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), value]);
  const parts: Buffer[] = [head(5, value.size)];
  for (const [key, entry] of value) parts.push(encodeCbor(key), encodeCbor(entry));
  return Buffer.concat(parts);
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest();

interface StoredCredential {
  readonly id: Buffer;
  readonly privateKey: KeyObject;
  readonly rpId: string;
  readonly userHandle: string;
  counter: number;
}

export interface CeremonyOptions {
  /** Whether the "user" passed biometric/PIN verification. Default true. */
  readonly userVerified?: boolean;
  /** Sign as if the page were this origin (to test origin binding). */
  readonly origin?: string;
  /** Flip a bit in the signature. */
  readonly tamper?: boolean;
  /** Report this signature counter instead of the next one. */
  readonly counter?: number;
}

export class SoftAuthenticator {
  readonly credentials: StoredCredential[] = [];

  create(
    options: { challenge: string; rp: { id?: string }; user: { id: string } },
    origin: string,
    ceremony: CeremonyOptions = {},
  ): Record<string, unknown> {
    const rpId = options.rp.id ?? new URL(origin).hostname;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const id = randomBytes(16);
    this.credentials.push({ id, privateKey, rpId, userHandle: options.user.id, counter: 0 });

    const coseKey = encodeCbor(
      new Map<number, Cbor>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    const flags = 0x01 | (ceremony.userVerified === false ? 0 : 0x04) | 0x40;
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(id.length);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), idLength, id, coseKey]);
    const attestationObject = encodeCbor(new Map<string, Cbor>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: ceremony.origin ?? origin, crossOrigin: false }),
    );
    return {
      id: b64(id),
      rawId: b64(id),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ['internal'] },
    };
  }

  get(options: { challenge: string; rpId?: string }, origin: string, ceremony: CeremonyOptions = {}): Record<string, unknown> {
    const rpId = options.rpId ?? new URL(origin).hostname;
    const credential = this.credentials.find((entry) => entry.rpId === rpId);
    if (!credential) throw new Error(`The authenticator holds no passkey for ${rpId}.`);
    credential.counter = ceremony.counter ?? credential.counter + 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(credential.counter);
    const flags = 0x01 | (ceremony.userVerified === false ? 0 : 0x04);
    const authenticatorData = Buffer.concat([sha256(rpId), Buffer.from([flags]), counter]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: ceremony.origin ?? origin, crossOrigin: false }),
    );
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), credential.privateKey);
    if (ceremony.tamper) signature[signature.length - 1] = signature[signature.length - 1]! ^ 0x01;
    return {
      id: b64(credential.id),
      rawId: b64(credential.id),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64(clientDataJSON),
        authenticatorData: b64(authenticatorData),
        signature: b64(signature),
        userHandle: credential.userHandle,
      },
    };
  }
}
