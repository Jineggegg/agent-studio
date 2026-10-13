import { describe, expect, it } from 'vitest';
import { SecretBox, hashPassword, newId, randomToken, safeEqual, verifyPassword } from './crypto.js';

describe('passwords', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(hash).not.toContain('correct horse');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('correct horse battery stapl', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hashPassword('same password here')).not.toBe(await hashPassword('same password here'));
  });

  it('rejects malformed stored hashes instead of throwing', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'scrypt$999999999$8$1$AAAA$AAAA')).toBe(false);
  });
});

describe('SecretBox', () => {
  const box = new SecretBox(Buffer.alloc(32, 7));

  it('round-trips and never stores plaintext', () => {
    const sealed = box.seal('sk-very-secret-value', 'provider:openai');
    expect(sealed).not.toContain('sk-very-secret-value');
    expect(box.open(sealed, 'provider:openai')).toBe('sk-very-secret-value');
  });

  it('refuses a ciphertext moved to another record', () => {
    const sealed = box.seal('value', 'record-a');
    expect(() => box.open(sealed, 'record-b')).toThrow();
  });

  it('refuses tampered ciphertext and the wrong key', () => {
    const sealed = box.seal('value', 'record');
    const parts = sealed.split('.');
    const flipped = Buffer.from(parts[2]!, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => box.open([parts[0], parts[1], flipped.toString('base64url'), parts[3]].join('.'), 'record')).toThrow();
    expect(() => new SecretBox(Buffer.alloc(32, 8)).open(sealed, 'record')).toThrow();
  });
});

describe('identifiers and tokens', () => {
  it('produces ids that sort by creation time', async () => {
    const first = newId();
    await new Promise((resolve) => setTimeout(resolve, 3));
    const second = newId();
    expect(first).toMatch(/^[0-9a-z]{26}$/);
    expect(first < second).toBe(true);
  });

  it('produces unpredictable tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));
    expect(tokens.size).toBe(200);
  });

  it('compares strings without early exit', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
