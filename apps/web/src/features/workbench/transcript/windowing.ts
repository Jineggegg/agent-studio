/**
 * The arithmetic of the windowed transcript: where each row sits given the
 * heights known so far, which rows are near the viewport, and — the part that
 * must never regress — where to scroll so that what the reader is looking at
 * stays exactly where it is while rows above it load, grow or are measured.
 *
 * Nothing here touches the DOM; `WindowedList.tsx` supplies the numbers.
 */
export interface WindowLayout {
  /** Top of each row, relative to the first row. */
  offsets: number[];
  heights: number[];
  total: number;
}

export function computeLayout(keys: readonly string[], measured: ReadonlyMap<string, number>, estimate: (index: number) => number): WindowLayout {
  const offsets = new Array<number>(keys.length);
  const heights = new Array<number>(keys.length);
  let top = 0;
  for (let index = 0; index < keys.length; index += 1) {
    const height = measured.get(keys[index]!) ?? Math.max(1, estimate(index));
    offsets[index] = top;
    heights[index] = height;
    top += height;
  }
  return { offsets, heights, total: top };
}

/** The index of the row that contains the offset `y` (clamped to the list). */
export function rowAt(layout: WindowLayout, y: number): number {
  const { offsets } = layout;
  if (offsets.length === 0) return 0;
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (offsets[middle]! <= y) low = middle;
    else high = middle - 1;
  }
  return low;
}

export interface RowRange {
  /** First row to render. */
  start: number;
  /** One past the last row to render. */
  end: number;
}

/** The rows within `overscan` px of the viewport. `scrollTop` is relative to the first row. */
export function visibleRange(layout: WindowLayout, scrollTop: number, viewport: number, overscan: number): RowRange {
  const count = layout.offsets.length;
  if (count === 0) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop - overscan);
  const bottom = Math.max(top, scrollTop + viewport + overscan);
  const start = rowAt(layout, top);
  const last = rowAt(layout, bottom);
  return { start, end: Math.min(count, last + 1) };
}

/** Space taken by the rows before and after the rendered range. */
export function padding(layout: WindowLayout, range: RowRange): { before: number; after: number } {
  const count = layout.offsets.length;
  if (count === 0 || range.end <= range.start) return { before: 0, after: layout.total };
  const before = layout.offsets[range.start]!;
  const lastRendered = range.end - 1;
  const after = layout.total - (layout.offsets[lastRendered]! + layout.heights[lastRendered]!);
  return { before, after: Math.max(0, after) };
}

/**
 * What the reader is looking at: a row, and how far its top is from the top
 * of the viewport (negative when the row starts above it).
 */
export interface Anchor {
  key: string;
  offset: number;
}

/** The first row that is at least partly below the top of the viewport. */
export function pickAnchor(keys: readonly string[], layout: WindowLayout, scrollTop: number): Anchor | null {
  if (keys.length === 0) return null;
  let index = rowAt(layout, Math.max(0, scrollTop));
  // A row that ends exactly at the top edge is no longer in view.
  while (index < keys.length - 1 && layout.offsets[index]! + layout.heights[index]! <= scrollTop) index += 1;
  return { key: keys[index]!, offset: layout.offsets[index]! - scrollTop };
}

/**
 * The scroll position that puts the anchor row back where it was. Null when
 * the row is gone (the caller keeps the position it has).
 */
export function scrollTopForAnchor(keys: readonly string[], layout: WindowLayout, anchor: Anchor): number | null {
  const index = keys.indexOf(anchor.key);
  if (index === -1) return null;
  return layout.offsets[index]! - anchor.offset;
}

export function maxScrollTop(total: number, viewport: number): number {
  return Math.max(0, total - viewport);
}

export function clampScrollTop(scrollTop: number, total: number, viewport: number): number {
  return Math.min(maxScrollTop(total, viewport), Math.max(0, scrollTop));
}

/** Close enough to the end that new rows should keep the view at the end. */
export function isNearBottom(scrollTop: number, viewport: number, total: number, threshold = 48): boolean {
  return total - (scrollTop + viewport) <= threshold;
}

/**
 * Where the list should be scrolled after its rows or their heights changed.
 *
 *  - following the end: the end;
 *  - otherwise: wherever keeps the anchor row at the same place on screen.
 */
export function resolveScrollTop(input: {
  keys: readonly string[];
  layout: WindowLayout;
  viewport: number;
  following: boolean;
  anchor: Anchor | null;
  /** Used when there is no anchor, or it is gone. */
  fallback: number;
}): number {
  const { keys, layout, viewport, following, anchor, fallback } = input;
  if (following) return maxScrollTop(layout.total, viewport);
  const anchored = anchor ? scrollTopForAnchor(keys, layout, anchor) : null;
  return clampScrollTop(anchored ?? fallback, layout.total, viewport);
}
