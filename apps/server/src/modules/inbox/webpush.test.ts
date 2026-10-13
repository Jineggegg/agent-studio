import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PushStandIn } from './testing/push-stand-in.js';
import { MAX_PUSH_PAYLOAD_BYTES, encryptPayload, generateVapidKeys, pushTopic, sendPush, validateSubscription, vapidAuthorization } from './webpush.js';

/** What a browser does with a received push message (RFC 8291 §3.4, RFC 8188 §2). */
function decryptAsBrowser(body: Buffer, browser: { privateKey: Buffer; publicKey: Buffer; auth: Buffer }): Buffer {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const keyLength = body.readUInt8(20);
  const serverPublic = body.subarray(21, 21 + keyLength);
  const ciphertext = body.subarray(21 + keyLength);
  expect(recordSize).toBe(4096);
  expect(ciphertext.length).toBeLessThanOrEqual(recordSize);

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(browser.privateKey);
  const shared = ecdh.computeSecret(serverPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), browser.publicKey, serverPublic]);
  const inputKey = Buffer.from(hkdfSync('sha256', shared, browser.auth, info, 32));
  const key = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', inputKey, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  const end = padded.lastIndexOf(2);
  return padded.subarray(0, end);
}

function newBrowser() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    privateKey: ecdh.getPrivateKey(),
    publicKey: ecdh.getPublicKey(),
    auth,
    subscription: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
}

describe('message encryption', () => {
  it('reproduces the worked example of RFC 8291 (appendix A) byte for byte', () => {
    const body = encryptPayload(
      {
        p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        auth: 'BTBZMqHH6r4Tts7J_aSIgg',
      },
      Buffer.from('When I grow up, I want to be a watermelon'),
      {
        privateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
        salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
      },
    );
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('produces something only the subscribed browser can read', () => {
    const browser = newBrowser();
    const message = Buffer.from(JSON.stringify({ title: '构建完成', body: 'Run finished ✅' }));
    const body = encryptPayload(browser.subscription, message);
    expect(body.includes(message)).toBe(false);
    expect(decryptAsBrowser(body, browser).toString()).toBe(message.toString());

    const stranger = newBrowser();
    expect(() => decryptAsBrowser(body, { ...stranger, auth: browser.auth })).toThrow();
    expect(() => decryptAsBrowser(body, { ...browser, auth: randomBytes(16) })).toThrow();
  });

  it('uses a fresh key and salt for every message', () => {
    const browser = newBrowser();
    const a = encryptPayload(browser.subscription, Buffer.from('same'));
    const b = encryptPayload(browser.subscription, Buffer.from('same'));
    expect(a.equals(b)).toBe(false);
  });

  it('refuses payloads that would not fit one record', () => {
    const browser = newBrowser();
    expect(() => encryptPayload(browser.subscription, Buffer.alloc(MAX_PUSH_PAYLOAD_BYTES + 1))).toThrow(/too large/);
    expect(decryptAsBrowser(encryptPayload(browser.subscription, Buffer.alloc(MAX_PUSH_PAYLOAD_BYTES, 65)), browser)).toHaveLength(MAX_PUSH_PAYLOAD_BYTES);
  });
});

describe('VAPID', () => {
  it('signs a token the push service can verify with the advertised public key', () => {
    const keys = generateVapidKeys();
    const header = vapidAuthorization(keys, 'https://fcm.googleapis.com', 'mailto:owner@example.com', 1_700_000_000_000);
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header)!;
    expect(match).not.toBeNull();
    const [, head, claims, signature, key] = match;
    expect(key).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(head!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(claims!, 'base64url').toString())).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: 1_700_000_000 + 12 * 60 * 60,
      sub: 'mailto:owner@example.com',
    });
    const point = Buffer.from(keys.publicKey, 'base64url');
    expect(point).toHaveLength(65);
    const publicKey = createPublicKey({
      format: 'jwk',
      key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url') },
    });
    expect(verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url'))).toBe(true);
  });
});

describe('where pushes may be sent', () => {
  const browser = newBrowser();
  const at = (endpoint: string) => ({ endpoint, ...browser.subscription });

  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
    'https://db5p.notify.windows.com/w/?token=abc',
  ])('accepts %s', (endpoint) => {
    expect(validateSubscription(at(endpoint)).href).toBe(endpoint);
  });

  it.each([
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://127.0.0.1/internal',
    'https://169.254.169.254/latest/meta-data',
    'https://attacker.example/collect',
    'https://fcm.googleapis.com.attacker.example/x',
    'https://evilfcm.googleapis.com.evil.example/x',
    'https://user:pw@fcm.googleapis.com/x',
    'file:///etc/passwd',
    'not a url',
  ])('refuses %s', (endpoint) => {
    expect(() => validateSubscription(at(endpoint))).toThrow();
  });

  it('refuses malformed keys', () => {
    expect(() => validateSubscription({ endpoint: 'https://fcm.googleapis.com/x', p256dh: 'AAAA', auth: browser.subscription.auth })).toThrow();
    expect(() => validateSubscription({ endpoint: 'https://fcm.googleapis.com/x', p256dh: browser.subscription.p256dh, auth: 'AAAA' })).toThrow();
  });

  it('never contacts an address that is not a public push service, even if a host is allow-listed', async () => {
    const outcome = await sendPush(
      at('https://localhost/push'),
      { payload: { title: 't' } },
      { keys: generateVapidKeys(), subject: 'mailto:owner@example.com' },
      { allowedHosts: ['localhost'], timeoutMs: 2000 },
    );
    expect(outcome.status).toBe('unreachable');
  });
});

describe('a stand-in push service, for tests', () => {
  const vapid = { keys: generateVapidKeys(), subject: 'mailto:owner@example.com' };

  it('is reachable only when the caller hands in both the host and the policy', async () => {
    const service = await PushStandIn.start();
    try {
      const browser = service.browser();
      const subscription = { endpoint: browser.endpoint, ...(browser.subscription().keys as { p256dh: string; auth: string }) };
      // The default: a loopback address over plain http is not a push service.
      expect(() => validateSubscription(subscription)).toThrow();
      expect(() => validateSubscription(subscription, service.allowedHosts)).toThrow();
      expect(() => validateSubscription(subscription, undefined, service.policy)).toThrow();
      expect((await sendPush(subscription, { payload: { title: 't' } }, vapid).catch((error: unknown) => error)) instanceof Error).toBe(true);
      expect((await sendPush(subscription, { payload: { title: 't' } }, vapid, { allowedHosts: service.allowedHosts }).catch((error: unknown) => error)) instanceof Error).toBe(true);
      expect(service.received).toEqual([]);

      // With both, a message arrives — encrypted, identified, and with the headers that govern delivery.
      expect(validateSubscription(subscription, service.allowedHosts, service.policy).href).toBe(browser.endpoint);
      const payload = { title: 'Release prep', body: 'Claude Code finished its reply', tag: 'reply-finished:s1', url: '/inbox' };
      const outcome = await sendPush(subscription, { payload, ttlSeconds: 600, urgency: 'high', topic: pushTopic('user-1\nreply-finished:s1') }, vapid, { allowedHosts: service.allowedHosts, policy: service.policy });
      expect(outcome).toEqual({ status: 'sent' });
      const [received] = service.to(browser);
      expect(received!.headers).toMatchObject({ 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '600', urgency: 'high', topic: pushTopic('user-1\nreply-finished:s1') });
      expect(received!.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
      expect(received!.body.includes(Buffer.from('Release prep'))).toBe(false);
      expect(browser.decrypt(received!.body)).toEqual(payload);
      // Another browser cannot read it.
      expect(() => service.browser().decrypt(received!.body)).toThrow();
    } finally {
      await service.close();
    }
  });

  it('reports what the service answers: gone, refused, unreachable', async () => {
    const service = await PushStandIn.start();
    const browser = service.browser();
    const subscription = { endpoint: browser.endpoint, ...(browser.subscription().keys as { p256dh: string; auth: string }) };
    const options = { allowedHosts: service.allowedHosts, policy: service.policy, timeoutMs: 2000 };
    const send = () => sendPush(subscription, { payload: { title: 't' } }, vapid, options);
    try {
      service.answer(browser, 410);
      expect(await send()).toEqual({ status: 'gone' });
      service.answer(browser, 404);
      expect(await send()).toEqual({ status: 'gone' });
      service.answer(browser, 413);
      expect(await send()).toEqual({ status: 'rejected', httpStatus: 413 });
      service.answer(browser, 500);
      expect(await send()).toEqual({ status: 'rejected', httpStatus: 500 });
      service.answer(browser, 204);
      expect(await send()).toEqual({ status: 'sent' });
    } finally {
      await service.close();
    }
    // Nobody is listening any more: said as such, not thrown.
    expect(await send()).toMatchObject({ status: 'unreachable' });
  });
});

describe('replacement topics', () => {
  it('are stable, URL-safe, at most 32 characters, and different for different keys', () => {
    const topic = pushTopic('user-1\nreply-finished:session-1');
    expect(topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(pushTopic('user-1\nreply-finished:session-1')).toBe(topic);
    expect(pushTopic('user-2\nreply-finished:session-1')).not.toBe(topic);
    expect(pushTopic('user-1\nreply-finished:session-2')).not.toBe(topic);
    expect(pushTopic('')).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});
