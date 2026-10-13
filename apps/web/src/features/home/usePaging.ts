import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { type LayoutClass, useLayoutClass } from '@/platform/layout';
import { prefersReducedMotion } from '@/platform/media';

export interface GridMetrics {
  columns: number;
  rows: number;
  /** Height of one row: the tile's own height, stretched a little so whole rows fill the page evenly. */
  rowHeight: number;
}

interface TileGeometry {
  /** Narrowest a cell may be. */
  minCell: number;
  /** Height of one tile row. */
  rowHeight: number;
  columnGap: number;
  rowGap: number;
  minColumns: number;
  maxColumns: number;
  /** Horizontal padding inside a page. */
  padding: number;
  /** The grid never grows wider than this. */
  maxWidth: number;
}

export const TILE_GEOMETRY: Record<LayoutClass, TileGeometry> = {
  phone: { minCell: 76, rowHeight: 112, columnGap: 8, rowGap: 14, minColumns: 3, maxColumns: 6, padding: 16, maxWidth: 560 },
  tablet: { minCell: 104, rowHeight: 126, columnGap: 16, rowGap: 22, minColumns: 4, maxColumns: 7, padding: 28, maxWidth: 880 },
  wide: { minCell: 108, rowHeight: 132, columnGap: 20, rowGap: 26, minColumns: 5, maxColumns: 8, padding: 40, maxWidth: 1120 },
};

/** A hidden or collapsed viewport says nothing about how many tiles fit. */
const MIN_MEASURABLE = 140;
/** A page that got shorter must stay shorter this long before tiles move (the soft keyboard comes and goes). */
const SHRINK_SETTLE_MS = 700;

/** How many whole columns and rows of tiles fit in a page of the given size. */
export function gridFor(width: number, height: number, geometry: TileGeometry): GridMetrics {
  const usable = Math.min(width, geometry.maxWidth) - geometry.padding * 2;
  const columns = Math.min(geometry.maxColumns, Math.max(geometry.minColumns, Math.floor((usable + geometry.columnGap) / (geometry.minCell + geometry.columnGap))));
  const rows = Math.max(1, Math.floor((height + geometry.rowGap) / (geometry.rowHeight + geometry.rowGap)));
  const shared = Math.floor((height - (rows - 1) * geometry.rowGap) / rows);
  const rowHeight = Math.max(geometry.rowHeight, Math.min(shared, Math.round(geometry.rowHeight * 1.22)));
  return { columns, rows, rowHeight };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += Math.max(1, size)) pages.push(items.slice(index, index + Math.max(1, size)));
  return pages.length > 0 ? pages : [[]];
}

export interface Paging {
  metrics: GridMetrics;
  page: number;
  goTo: (page: number, options?: { animate?: boolean }) => void;
  /** Call from the pager's scroll handler. */
  onScroll: () => void;
}

/**
 * Measures the pager from its real layout and keeps track of the page on
 * show. Only whole rows count; a width change (rotation, split view) applies
 * at once, a height loss only after it has lasted; the current page survives
 * every re-layout, falling back to the last page that still exists.
 */
export function usePaging(pager: RefObject<HTMLElement | null>, pageCount: (metrics: GridMetrics) => number): Paging {
  const layout = useLayoutClass();
  const geometry = TILE_GEOMETRY[layout];
  const [metrics, setMetrics] = useState<GridMetrics>({ columns: geometry.minColumns + 1, rows: 4, rowHeight: geometry.rowHeight });
  const [page, setPage] = useState(0);
  const pageRef = useRef(0);
  const size = useRef({ width: 0, height: 0 });
  const programmatic = useRef(0);

  useLayoutEffect(() => {
    const element = pager.current;
    if (!element) return;
    let shrinkTimer = 0;

    const apply = (width: number, height: number) => {
      size.current = { width, height };
      const next = gridFor(width, height, geometry);
      setMetrics((current) => (current.columns === next.columns && current.rows === next.rows && current.rowHeight === next.rowHeight ? current : next));
    };
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      // Never measure a hidden or tiny viewport, and never let an empty reading replace a good one.
      if (width < MIN_MEASURABLE || height < MIN_MEASURABLE) return;
      const previous = size.current;
      window.clearTimeout(shrinkTimer);
      if (previous.width === 0 || width !== previous.width || height >= previous.height) {
        apply(width, height);
        // Stay on the same page at the new width.
        element.scrollLeft = pageRef.current * width;
        return;
      }
      shrinkTimer = window.setTimeout(() => {
        if (element.clientHeight === height && element.clientWidth === width) apply(width, height);
      }, SHRINK_SETTLE_MS);
    };

    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      window.clearTimeout(shrinkTimer);
    };
  }, [pager, geometry]);

  const count = pageCount(metrics);

  // Pages disappeared (tiles removed, a bigger grid): show the last one that still exists.
  useEffect(() => {
    if (pageRef.current <= count - 1) return;
    const last = Math.max(0, count - 1);
    pageRef.current = last;
    setPage(last);
    const element = pager.current;
    if (element) element.scrollLeft = last * element.clientWidth;
  }, [count, pager]);

  const goTo = useCallback(
    (target: number, options: { animate?: boolean } = {}) => {
      const element = pager.current;
      const next = Math.min(Math.max(target, 0), Math.max(0, count - 1));
      pageRef.current = next;
      setPage(next);
      if (!element) return;
      const animate = (options.animate ?? true) && !prefersReducedMotion();
      programmatic.current = Date.now();
      if (typeof element.scrollTo === 'function') element.scrollTo({ left: next * element.clientWidth, behavior: animate ? 'smooth' : 'auto' });
      else element.scrollLeft = next * element.clientWidth;
    },
    [count, pager],
  );

  const onScroll = useCallback(() => {
    const element = pager.current;
    if (!element || element.clientWidth === 0) return;
    const current = Math.round(element.scrollLeft / element.clientWidth);
    // While a programmatic turn is under way the target page is already known; do not flicker through the ones in between.
    if (Date.now() - programmatic.current < 500 && current !== pageRef.current) return;
    if (current !== pageRef.current) {
      pageRef.current = current;
      setPage(current);
    }
  }, [pager]);

  return { metrics, page, goTo, onScroll };
}
