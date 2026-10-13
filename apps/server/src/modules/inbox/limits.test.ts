import { describe, expect, it } from 'vitest';
import { DedupeWindow, SlidingRate } from './limits.js';

function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => void (at += ms) };
}

describe('the dedupe window', () => {
  it('lets a key through once, and again only after the window has passed', () => {
    const time = clock();
    const window = new DedupeWindow(20_000, time.now);
    expect(window.admit('needs-you|s1')).toBe(true);
    // Reported three times within five seconds: one notification.
    time.advance(2_000);
    expect(window.admit('needs-you|s1')).toBe(false);
    time.advance(3_000);
    expect(window.admit('needs-you|s1')).toBe(false);
    // 25 seconds after the first: news again.
    time.advance(20_000);
    expect(window.admit('needs-you|s1')).toBe(true);
    expect(window.admit('needs-you|s1')).toBe(false);
  });

  it('a repeat does not extend the window, and the boundary is exact', () => {
    const time = clock();
    const window = new DedupeWindow(20_000, time.now);
    expect(window.admit('k')).toBe(true);
    time.advance(19_999);
    expect(window.admit('k')).toBe(false);
    time.advance(1);
    expect(window.admit('k')).toBe(true);
  });

  it('keeps different events apart', () => {
    const time = clock();
    const window = new DedupeWindow(20_000, time.now);
    expect(window.admit('failed|s1|rate_limited')).toBe(true);
    expect(window.admit('failed|s1|agent_error')).toBe(true);
    expect(window.admit('failed|s2|rate_limited')).toBe(true);
    expect(window.admit('finished|s1|run-1')).toBe(true);
    expect(window.admit('finished|s1|run-2')).toBe(true);
    expect(window.admit('failed|s1|rate_limited')).toBe(false);
  });

  it('does not grow without bound', () => {
    const time = clock();
    const window = new DedupeWindow(20_000, time.now, 100);
    for (let index = 0; index < 1_000; index += 1) {
      window.admit(`key-${index}`);
      time.advance(10);
    }
    expect(window.size).toBeLessThanOrEqual(101);
    // The most recent ones are still remembered.
    expect(window.admit('key-999')).toBe(false);
    // Everything expires: after the window a burst of old keys leaves nothing behind but itself.
    time.advance(60_000);
    expect(window.admit('fresh')).toBe(true);
    for (let index = 0; index < 200; index += 1) window.admit(`later-${index}`);
    expect(window.size).toBeLessThanOrEqual(101);
  });
});

describe('the sliding rate', () => {
  it('admits the limit within any window and refuses the rest — nothing is queued for later', () => {
    const time = clock();
    const rate = new SlidingRate(3, 60_000, time.now);
    expect([rate.take('u1'), rate.take('u1'), rate.take('u1')]).toEqual([true, true, true]);
    expect(rate.take('u1')).toBe(false);
    expect(rate.take('u1')).toBe(false);
    // Another user is not affected.
    expect(rate.take('u2')).toBe(true);

    // What was refused is gone: when the window has moved on, exactly the limit fits again.
    time.advance(60_000);
    expect([rate.take('u1'), rate.take('u1'), rate.take('u1'), rate.take('u1')]).toEqual([true, true, true, false]);
  });

  it('slides: room appears as the oldest event leaves the window', () => {
    const time = clock();
    const rate = new SlidingRate(2, 10_000, time.now);
    expect(rate.take('u')).toBe(true);
    time.advance(4_000);
    expect(rate.take('u')).toBe(true);
    expect(rate.take('u')).toBe(false);
    expect(rate.waitMs('u')).toBe(6_000);
    time.advance(5_999);
    expect(rate.take('u')).toBe(false);
    expect(rate.waitMs('u')).toBe(1);
    time.advance(1);
    expect(rate.waitMs('u')).toBe(0);
    expect(rate.take('u')).toBe(true);
    // Now the event from second 4 is the oldest.
    expect(rate.waitMs('u')).toBe(4_000);
  });

  it('a refused attempt does not count against the limit', () => {
    const time = clock();
    const rate = new SlidingRate(1, 10_000, time.now);
    expect(rate.take('u')).toBe(true);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      time.advance(100);
      expect(rate.take('u')).toBe(false);
    }
    time.advance(5_000);
    expect(rate.take('u')).toBe(true);
    expect(rate.waitMs('never-seen')).toBe(0);
  });
});
