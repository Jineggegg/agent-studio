import { createHash, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

/**
 * A tiny software WebAuthn authenticator for the acceptance tests — enough of
 * a P-256 platform authenticator to register a passkey and answer a sign-in
 * challenge, with knobs to misbehave (skip user verification, replay a stale
 * counter, sign the wrong challenge) so the server's refusals can be checked.
 *
 * It speaks the JSON shapes `@simplewebauthn/browser` produces, which is what
 * the server verifies: all binary fields are base64url. Nothing here imports
 * server code; it only needs `node:crypto`.
 */

const b64url = (data: Buffer | Uint8Array): string => Buffer.from(data).toString('base64url');

// --- a minimal CBOR encoder: unsigned/negative ints, byte/text strings, maps ---

function cborHead(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) {
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(value, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(value, 1);
  return b;
}

type Cbor = number | string | Buffer | Map<Cbor, Cbor>;

function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -value - 1);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([cborHead(2, value.length), value]);
  }
  const parts = [cborHead(5, value.size)];
  for (const [k, v] of value) parts.push(cbor(k), cbor(v));
  return Buffer.concat(parts);
}

/** The public key in COSE_Key form for an ES256 (P-256) credential. */
function cosePublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' });
  const x = Buffer.from(jwk.x!, 'base64url');
  const y = Buffer.from(jwk.y!, 'base64url');
  const map = new Map<Cbor, Cbor>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, x],
    [-3, y],
  ]);
  return cbor(map);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

function authenticatorData(
  rpId: string,
  flags: number,
  signCount: number,
  attestedCredential?: Buffer,
): Buffer {
  const rpIdHash = createHash('sha256').update(rpId).digest();
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(signCount, 1);
  return Buffer.concat([rpIdHash, header, attestedCredential ?? Buffer.alloc(0)]);
}

export interface SoftwarePasskeyOptions {
  /** Pretend the user did not verify (no biometric/PIN): the UV flag is cleared. */
  readonly userVerified?: boolean;
  /** Override the sign counter put in the assertion (to test a replayed/old counter). */
  readonly signCount?: number;
  /** Sign a different origin's client data than the one claimed. */
  readonly clientOrigin?: string;
}

export interface RegistrationOptionsJSON {
  readonly challenge: string;
  readonly rp: { readonly id: string };
  readonly user: { readonly id: string };
}

export interface AuthenticationOptionsJSON {
  readonly challenge: string;
}

/** The shape `@simplewebauthn/browser` returns from `navigator.credentials.get`. */
export interface AssertionResponseJSON {
  id: string;
  rawId: string;
  type: 'public-key';
  clientExtensionResults: Record<string, unknown>;
  authenticatorAttachment: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle: string;
  };
}

/**
 * One virtual authenticator holding one credential. Create it with
 * {@link SoftwareAuthenticator.create} against the server's registration
 * options, then use it to answer sign-in challenges.
 */
export class SoftwareAuthenticator {
  #counter = 0;
  readonly #privateKey: KeyObject;
  readonly credentialId: Buffer;
  readonly userHandle: string;

  private constructor(
    credentialId: Buffer,
    privateKey: KeyObject,
    _publicKey: KeyObject,
    userHandle: string,
  ) {
    this.credentialId = credentialId;
    this.#privateKey = privateKey;
    this.userHandle = userHandle;
  }

  /** Builds the JSON a browser would return from `navigator.credentials.create`. */
  static register(
    options: RegistrationOptionsJSON,
    origin: string,
    overrides: { readonly userVerified?: boolean; readonly credentialId?: Buffer } = {},
  ): { credential: unknown; authenticator: SoftwareAuthenticator } {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const credentialId = overrides.credentialId ?? Buffer.from(randomId());
    const authenticator = new SoftwareAuthenticator(
      credentialId,
      privateKey,
      publicKey,
      options.user.id,
    );

    const clientData = {
      type: 'webauthn.create',
      challenge: options.challenge,
      origin,
      crossOrigin: false,
    };
    const clientDataJSON = Buffer.from(JSON.stringify(clientData), 'utf8');

    const aaguid = Buffer.alloc(16);
    const credIdLen = Buffer.alloc(2);
    credIdLen.writeUInt16BE(credentialId.length);
    const attestedCredential = Buffer.concat([
      aaguid,
      credIdLen,
      credentialId,
      cosePublicKey(publicKey),
    ]);
    const flags = FLAG_UP | FLAG_AT | (overrides.userVerified === false ? 0 : FLAG_UV);
    const authData = authenticatorData(options.rp.id, flags, 0, attestedCredential);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );

    const credential = {
      id: b64url(credentialId),
      rawId: b64url(credentialId),
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
    };
    return { credential, authenticator };
  }

  /** Builds the JSON a browser would return from `navigator.credentials.get`. */
  assert(
    options: AuthenticationOptionsJSON,
    origin: string,
    opts: SoftwarePasskeyOptions = {},
  ): AssertionResponseJSON {
    const claimedChallenge = options.challenge;
    const clientData = {
      type: 'webauthn.get',
      challenge: claimedChallenge,
      origin: opts.clientOrigin ?? origin,
      crossOrigin: false,
    };
    const clientDataJSON = Buffer.from(JSON.stringify(clientData), 'utf8');
    const clientDataHash = createHash('sha256').update(clientDataJSON).digest();

    this.#counter += 1;
    const signCount = opts.signCount ?? this.#counter;
    const flags = FLAG_UP | (opts.userVerified === false ? 0 : FLAG_UV);
    const authData = authenticatorData(this.rpIdFromOrigin(origin), flags, signCount);
    const signature = createSign('SHA256')
      .update(Buffer.concat([authData, clientDataHash]))
      .sign({ key: this.#privateKey, dsaEncoding: 'der' });

    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: 'public-key',
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        userHandle: this.userHandle,
      },
    };
  }

  /** The relying-party id is the host of the origin a request was sent to. */
  rpIdFromOrigin(origin: string): string {
    return new URL(origin).hostname;
  }
}

function randomId(length = 20): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}
