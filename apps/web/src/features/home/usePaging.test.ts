import { describe, expect, it } from 'vitest';
import { TILE_GEOMETRY, chunk, gridFor } from './usePaging';

describe('home paging', () => {
  it('counts only whole rows and columns', () => {
    const phone = TILE_GEOMETRY.phone;
    const grid = gridFor(390, 600, phone);
    expect(grid.columns).toBe(4);
    // 600 px fits four rows of 112 with 14 px gaps (4 × 112 + 3 × 14 = 490), not five (616)
    expect(grid.rows).toBe(4);
    expect(gridFor(390, 616, phone).rows).toBe(5);
    expect(gridFor(390, 615, phone).rows).toBe(4);
  });

  it('keeps within the column limits of each layout class and never returns an empty page', () => {
    expect(gridFor(320, 500, TILE_GEOMETRY.phone).columns).toBeGreaterThanOrEqual(3);
    expect(gridFor(699, 500, TILE_GEOMETRY.phone).columns).toBeLessThanOrEqual(6);
    expect(gridFor(820, 900, TILE_GEOMETRY.tablet).columns).toBe(6);
    expect(gridFor(1440, 700, TILE_GEOMETRY.wide).columns).toBe(8);
    expect(gridFor(2560, 700, TILE_GEOMETRY.wide).columns).toBe(8); // the grid stops growing
    expect(gridFor(390, 60, TILE_GEOMETRY.phone).rows).toBe(1);
  });

  it('flows tiles onto as many pages as they need', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2], 20)).toEqual([[1, 2]]);
    expect(chunk([], 20)).toEqual([[]]); // one empty page, not none
    expect(chunk([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
  });
});
