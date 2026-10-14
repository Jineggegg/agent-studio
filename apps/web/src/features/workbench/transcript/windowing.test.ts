import { describe, expect, it } from 'vitest';
import { clampScrollTop, computeLayout, isNearBottom, maxScrollTop, padding, pickAnchor, resolveScrollTop, rowAt, scrollTopForAnchor, visibleRange } from './windowing';

const keys = (count: number, prefix = 'r') => Array.from({ length: count }, (_, index) => `${prefix}${index}`);
const uniform = (count: number, height = 100) => computeLayout(keys(count), new Map(), () => height);

describe('layout', () => {
  it('stacks rows from measured heights, estimating the ones not seen yet', () => {
    const layout = computeLayout(['a', 'b', 'c'], new Map([['b', 250]]), () => 100);
    expect(layout.offsets).toEqual([0, 100, 350]);
    expect(layout.heights).toEqual([100, 250, 100]);
    expect(layout.total).toBe(450);
  });

  it('never lets an estimate collapse a row to nothing', () => {
    expect(computeLayout(['a', 'b'], new Map(), () => 0).offsets).toEqual([0, 1]);
  });

  it.each([
    [0, 0],
    [99, 0],
    [100, 1],
    [250, 2],
    [999, 9],
    [5000, 9],
    [-20, 0],
  ])('finds the row at offset %i', (y, expected) => {
    expect(rowAt(uniform(10), y)).toBe(expected);
  });
});

describe('the rendered window', () => {
  it('is the rows near the viewport and nothing else', () => {
    const layout = uniform(1000);
    const range = visibleRange(layout, 50_000, 800, 400);
    expect(range).toEqual({ start: 496, end: 513 });
    expect(range.end - range.start).toBeLessThan(20);
  });

  it('stops at the ends of the list', () => {
    const layout = uniform(10);
    expect(visibleRange(layout, 0, 300, 500)).toEqual({ start: 0, end: 9 });
    expect(visibleRange(layout, 700, 300, 500)).toEqual({ start: 2, end: 10 });
    expect(visibleRange(uniform(0), 0, 300, 500)).toEqual({ start: 0, end: 0 });
  });

  it('pads for exactly the rows it leaves out', () => {
    const layout = uniform(100);
    const range = { start: 40, end: 50 };
    expect(padding(layout, range)).toEqual({ before: 4000, after: 5000 });
    expect(padding(layout, { start: 0, end: 100 })).toEqual({ before: 0, after: 0 });
  });
});

describe('scroll anchoring', () => {
  it('anchors on the first row still in view, with how far it has scrolled off', () => {
    const layout = uniform(50);
    expect(pickAnchor(keys(50), layout, 1230)).toEqual({ key: 'r12', offset: -30 });
    expect(pickAnchor(keys(50), layout, 0)).toEqual({ key: 'r0', offset: 0 });
    // A row that ends exactly at the top edge is out of view: the next one is the anchor.
    expect(pickAnchor(keys(50), layout, 1300)).toEqual({ key: 'r13', offset: 0 });
  });

  it('keeps the anchor where it was when older rows are put in front', () => {
    const before = keys(50);
    const anchor = pickAnchor(before, uniform(50), 1230)!;
    const after = [...keys(30, 'older'), ...before];
    const layout = computeLayout(after, new Map(), (index) => (index < 30 ? 70 : 100));
    // 30 rows of 70 px were added above: the same row, the same 30 px scrolled off.
    expect(scrollTopForAnchor(after, layout, anchor)).toBe(30 * 70 + 1230);
  });

  it('keeps the anchor where it was when a row above turns out taller than estimated', () => {
    const list = keys(50);
    const anchor = pickAnchor(list, uniform(50), 2000)!;
    const measured = computeLayout(list, new Map([['r3', 460]]), () => 100);
    expect(scrollTopForAnchor(list, measured, anchor)).toBe(2360);
  });

  it('does not move when something below the anchor grows', () => {
    const list = keys(50);
    const anchor = pickAnchor(list, uniform(50), 2000)!;
    const grown = computeLayout(list, new Map([['r40', 900]]), () => 100);
    expect(scrollTopForAnchor(list, grown, anchor)).toBe(2000);
  });

  it('reports a vanished anchor instead of guessing', () => {
    expect(scrollTopForAnchor(keys(5), uniform(5), { key: 'gone', offset: 0 })).toBeNull();
  });
});

describe('where to scroll after a change', () => {
  const list = keys(50);
  const layout = uniform(50);

  it('stays at the end while following', () => {
    expect(resolveScrollTop({ keys: list, layout, viewport: 800, following: true, anchor: { key: 'r3', offset: 0 }, fallback: 0 })).toBe(4200);
  });

  it('stays on the anchor while reading back', () => {
    expect(resolveScrollTop({ keys: list, layout, viewport: 800, following: false, anchor: { key: 'r12', offset: -30 }, fallback: 0 })).toBe(1230);
  });

  it('falls back to the position it had when the anchor is gone, within bounds', () => {
    expect(resolveScrollTop({ keys: list, layout, viewport: 800, following: false, anchor: { key: 'gone', offset: 0 }, fallback: 900 })).toBe(900);
    expect(resolveScrollTop({ keys: list, layout, viewport: 800, following: false, anchor: null, fallback: 99_999 })).toBe(4200);
  });

  it('knows the end, and when the view is close enough to it to keep following', () => {
    expect(maxScrollTop(5000, 800)).toBe(4200);
    expect(maxScrollTop(300, 800)).toBe(0);
    expect(clampScrollTop(-5, 5000, 800)).toBe(0);
    expect(isNearBottom(4200, 800, 5000)).toBe(true);
    expect(isNearBottom(4160, 800, 5000)).toBe(true);
    expect(isNearBottom(4100, 800, 5000)).toBe(false);
    // A list shorter than the viewport is always at its end.
    expect(isNearBottom(0, 800, 300)).toBe(true);
  });
});
