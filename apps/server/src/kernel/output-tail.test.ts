import { describe, expect, it } from 'vitest';
import { OutputTail } from './output-tail.js';

const TOKEN = 'ghp_ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7ZQ7';
const PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7ZQ7ZQ7ZQ7ZQ7\n-----END PRIVATE KEY-----';

describe('the tail of a program’s output', () => {
  it('redacts a secret that straddles the cut while it is still whole', () => {
    const tail = new OutputTail(100);
    tail.append(`${'a'.repeat(9)} ${TOKEN} ${'b'.repeat(79)}`);
    expect(tail.text()).toBe(`${'a'.repeat(9)} [redacted] ${'b'.repeat(79)}`);
    expect(tail.text()).not.toContain('ZQ7');
  });

  it('redacts a secret split between chunks, including a private key over several lines', () => {
    const tail = new OutputTail(1000);
    const output = `starting\n${PEM}\nthen ${TOKEN} failed\n`;
    for (let offset = 0; offset < output.length; offset += 7) tail.append(output.slice(offset, offset + 7));
    expect(tail.text()).toBe('starting\n[redacted]\nthen [redacted] failed\n');
  });

  it('keeps only the newest characters', () => {
    const tail = new OutputTail(20);
    for (let i = 0; i < 100; i += 1) tail.append(`line ${i}\n`);
    expect(tail.text()).toHaveLength(20);
    expect(tail.text().endsWith('line 99\n')).toBe(true);
  });
});
