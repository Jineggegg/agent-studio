import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PushPayload, PushSubscribeRequest } from '@agent-studio/protocol';
import type { NetPolicy } from '../../../kernel/net.js';

/**
 * A push service for tests: a plain HTTP server on the loopback interface
 * that records what it is sent and answers as told. No test ever talks to a
 * real push service.
 *
 * A {@link FakeBrowser} is the other end: it owns the key pair and secret of
 * a subscription and can decrypt what was sent to it, exactly as a browser
 * would (RFC 8291) — so tests assert on what a lock screen would really show.
 */

export interface ReceivedPush {
  /** The path of the endpoint the message was sent to. */
  readonly path: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Buffer;
}

export class FakeBrowser {
  readonly endpoint: string;
  readonly path: string;
  readonly #privateKey: Buffer;
  readonly #publicKey: Buffer;
  readonly #auth: Buffer;

  constructor(origin: string, name: string) {
    this.path = `/push/${name}-${randomBytes(6).toString('hex')}`;
    this.endpoint = `${origin}${this.path}`;
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    this.#privateKey = ecdh.getPrivateKey();
    this.#publicKey = ecdh.getPublicKey();
    this.#auth = randomBytes(16);
  }

  /** What `PushSubscription.toJSON()` would give the page. */
  subscription(extra: Partial<PushSubscribeRequest> = {}): Record<string, unknown> {
    return {
      endpoint: this.endpoint,
      expirationTime: null,
      keys: { p256dh: this.#publicKey.toString('base64url'), auth: this.#auth.toString('base64url') },
      ...extra,
    };
  }

  /** Decrypts a received message body into the JSON the service worker would see. */
  decrypt(body: Buffer): PushPayload {
    const salt = body.subarray(0, 16);
    const keyLength = body.readUInt8(20);
    const serverPublic = body.subarray(21, 21 + keyLength);
    const ciphertext = body.subarray(21 + keyLength);
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(this.#privateKey);
    const shared = ecdh.computeSecret(serverPublic);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), this.#publicKey, serverPublic]);
    const inputKey = Buffer.from(hkdfSync('sha256', shared, this.#auth, info, 32));
    const key = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const decipher = createDecipheriv('aes-128-gcm', key, nonce);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
    return JSON.parse(padded.subarray(0, padded.lastIndexOf(2)).toString('utf8')) as PushPayload;
  }
}

export class PushStandIn {
  /** Everything received, oldest first. */
  readonly received: ReceivedPush[] = [];
  /** The largest number of requests that were being handled at the same moment. */
  maxConcurrent = 0;
  readonly origin: string;
  /** Pass these to the inbox module so that it will talk to this server — only ever in tests. */
  readonly allowedHosts: readonly string[] = ['127.0.0.1'];
  readonly policy: NetPolicy = { allowHttp: true, allowPrivateNetwork: true };
  readonly #server: http.Server;
  readonly #status = new Map<string, number>();
  readonly #held = new Map<string, Array<() => void>>();
  #defaultStatus = 201;
  #concurrent = 0;

  private constructor(server: http.Server) {
    this.#server = server;
    this.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    server.on('request', (request: http.IncomingMessage, response: http.ServerResponse) => {
      const chunks: Buffer[] = [];
      this.#concurrent += 1;
      this.maxConcurrent = Math.max(this.maxConcurrent, this.#concurrent);
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const path = request.url ?? '/';
        this.received.push({ path, headers: request.headers, body: Buffer.concat(chunks) });
        const answer = (): void => {
          this.#concurrent -= 1;
          response.writeHead(this.#status.get(path) ?? this.#defaultStatus).end();
        };
        const held = this.#held.get(path);
        if (held) held.push(answer);
        else answer();
      });
    });
  }

  static start(): Promise<PushStandIn> {
    return new Promise((resolve, reject) => {
      const server = http.createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve(new PushStandIn(server)));
    });
  }

  browser(name = 'device'): FakeBrowser {
    return new FakeBrowser(this.origin, name);
  }

  /** How the service answers messages for one browser from now on (201 accepted, 410 gone, 500 …). */
  answer(browser: FakeBrowser, status: number): void {
    this.#status.set(browser.path, status);
  }

  answerAll(status: number): void {
    this.#defaultStatus = status;
  }

  /** Makes the service sit on messages for a browser until the returned function is called. */
  hold(browser: FakeBrowser): () => void {
    this.#held.set(browser.path, []);
    return () => {
      const waiting = this.#held.get(browser.path) ?? [];
      this.#held.delete(browser.path);
      for (const answer of waiting) answer();
    };
  }

  /** What was sent to a browser, in order. */
  to(browser: FakeBrowser): ReceivedPush[] {
    return this.received.filter((entry) => entry.path === browser.path);
  }

  /** What a browser's service worker would have been handed, in order. */
  payloads(browser: FakeBrowser): PushPayload[] {
    return this.to(browser).map((entry) => browser.decrypt(entry.body));
  }

  close(): Promise<void> {
    for (const path of [...this.#held.keys()]) {
      const waiting = this.#held.get(path) ?? [];
      this.#held.delete(path);
      for (const answer of waiting) answer();
    }
    return new Promise((resolve) => {
      this.#server.closeAllConnections();
      this.#server.close(() => resolve());
    });
  }
}
