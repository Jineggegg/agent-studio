import { describe, expect, it } from 'vitest';
import { ByteRing, alignReplayStart } from './byte-ring.js';

const bytes = (text: string) => Buffer.from(text, 'utf8');

describe('ByteRing', () => {
  it('numbers every byte and returns what was written', () => {
    const ring = new ByteRing(64);
    expect([ring.start, ring.end, ring.length]).toEqual([0, 0, 0]);
    ring.write(bytes('hello '));
    ring.write(bytes('world'));
    expect([ring.start, ring.end, ring.length]).toEqual([0, 11, 11]);
    expect(ring.read().toString()).toBe('hello world');
    expect(ring.read(6).toString()).toBe('world');
    expect(ring.read(11).length).toBe(0);
  });

  it('drops the oldest bytes once full and keeps counting', () => {
    const ring = new ByteRing(8, 2);
    ring.write(bytes('abcdef'));
    ring.write(bytes('ghij'));
    expect([ring.start, ring.end, ring.length]).toEqual([2, 10, 8]);
    expect(ring.read().toString()).toBe('cdefghij');
    expect(ring.read(7).toString()).toBe('hij');
    ring.write(bytes('k'));
    expect(ring.read().toString()).toBe('defghijk');
    expect(ring.start).toBe(3);
  });

  it('clamps a position that is no longer kept, or not yet written', () => {
    const ring = new ByteRing(4);
    ring.write(bytes('abcdefgh'));
    expect(ring.read(0).toString()).toBe('efgh');
    expect(ring.read(-5).toString()).toBe('efgh');
    expect(ring.read(1000).length).toBe(0);
  });

  it('keeps only the tail of a chunk larger than the whole buffer', () => {
    const ring = new ByteRing(4);
    ring.write(bytes('ab'));
    ring.write(bytes('0123456789'));
    expect(ring.read().toString()).toBe('6789');
    expect([ring.start, ring.end]).toEqual([8, 12]);
    ring.write(bytes('xy'));
    expect(ring.read().toString()).toBe('89xy');
  });

  it('copies what it stores', () => {
    const ring = new ByteRing(16);
    const chunk = bytes('mutable');
    ring.write(chunk);
    chunk.fill(0x21);
    expect(ring.read().toString()).toBe('mutable');
    const out = ring.read();
    out.fill(0x21);
    expect(ring.read().toString()).toBe('mutable');
  });

  it('ignores empty writes and refuses a nonsensical capacity', () => {
    const ring = new ByteRing(4);
    ring.write(Buffer.alloc(0));
    expect(ring.end).toBe(0);
    expect(() => new ByteRing(0)).toThrow();
    expect(() => new ByteRing(1.5)).toThrow();
  });

  it('agrees with a plain array for any sequence of writes', () => {
    // A small deterministic generator, so a failure can be reproduced.
    let seed = 0x2f6e2b1;
    const random = (max: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % max;
    };
    for (const capacity of [1, 7, 64, 1000]) {
      const ring = new ByteRing(capacity, 3);
      let all: number[] = [];
      for (let round = 0; round < 400; round += 1) {
        const chunk = Buffer.from(Array.from({ length: random(capacity * 2 + 3) }, () => random(256)));
        ring.write(chunk);
        all = all.concat([...chunk]);
        const kept = all.slice(Math.max(0, all.length - capacity));
        expect(ring.end).toBe(all.length);
        expect(ring.start).toBe(all.length - kept.length);
        expect([...ring.read()]).toEqual(kept);
        const from = ring.start + random(kept.length + 1);
        expect([...ring.read(from)]).toEqual(all.slice(from));
      }
    }
  });
});

describe('alignReplayStart', () => {
  it('starts after the first line break when there is one nearby', () => {
    expect(alignReplayStart(bytes('tail of a line\nnext line\n'))).toBe(15);
    expect(alignReplayStart(bytes('\nrest'))).toBe(1);
  });

  it('otherwise skips the remainder of a split character', () => {
    const snowman = bytes('☃'); // three bytes
    expect(alignReplayStart(Buffer.concat([snowman.subarray(1), bytes('abc')]))).toBe(2);
    expect(alignReplayStart(Buffer.concat([snowman.subarray(2), bytes('abc')]))).toBe(1);
    expect(alignReplayStart(bytes('abc'))).toBe(0);
    expect(alignReplayStart(Buffer.alloc(0))).toBe(0);
  });

  it('does not search the whole buffer for a line break', () => {
    const far = Buffer.concat([Buffer.alloc(5000, 0x78), bytes('\nline')]);
    expect(alignReplayStart(far)).toBe(0);
    expect(alignReplayStart(far, 6000)).toBe(5001);
  });
});
