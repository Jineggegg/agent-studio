import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LayoutClass } from '@/platform/layout';
import { prefersReducedMotion } from '@/platform/media';

export interface GridMetrics {
  columns: number;
  rows: number;
  /** Height of one row: the tile's own height, stretched a little so whole rows fill the page evenly. */
  rowHeight: number;
}

export interface TileGeometry {
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
  /** How far a row may grow to share out the page's spare height: a phone's page is filled evenly, a desktop's stays compact. */
  stretch: number;
}

export const TILE_GEOMETRY: Record<LayoutClass, TileGeometry> = {
  phone: { minCell: 76, rowHeight: 112, columnGap: 8, rowGap: 14, minColumns: 3, maxColumns: 6, padding: 16, maxWidth: 560, stretch: 1.22 },
  tablet: { minCell: 104, rowHeight: 126, columnGap: 16, rowGap: 22, minColumns: 4, maxColumns: 7, padding: 28, maxWidth: 880, stretch: 1.1 },
  wide: { minCell: 108, rowHeight: 132, columnGap: 20, rowGap: 26, minColumns: 5, maxColumns: 8, padding: 40, maxWidth: 1120, stretch: 1.04 },
};

/** The same grid with large icons: fewer, bigger cells. */
export function largeGeometry(geometry: TileGeometry): TileGeometry {
  return { ...geometry, minCell: Math.round(geometry.minCell * 1.3), rowHeight: Math.round(geometry.rowHeight * 1.2), minColumns: Math.max(2, geometry.minColumns - 1) };
}

/** Room a row keeps for two lines of name under the tiles. */
const NAME_ROOM = 32;

/** Without names under the tiles, rows need no room for them: closer together, and more to a page. */
export function namelessGeometry(geometry: TileGeometry): TileGeometry {
  return { ...geometry, rowHeight: geometry.rowHeight - NAME_ROOM };
}

/** A hidden or collapsed viewport says nothing about how many tiles fit. */
const MIN_MEASURABLE = 140;
/** A page that got shorter must stay shorter this long before tiles move (the soft keyboard comes and goes). */
const SHRINK_SETTLE_MS = 700;
/** How long after mounting or a change of the screen's own layout a smaller pager is believed at once. */
const PROMPT_WINDOW_MS = 1_200;

/** How many whole columns and rows of tiles fit in a page of the given size. */
export function gridFor(width: number, height: number, geometry: TileGeometry): GridMetrics {
  const usable = Math.min(width, geometry.maxWidth) - geometry.padding * 2;
  const columns = Math.min(geometry.maxColumns, Math.max(geometry.minColumns, Math.floor((usable + geometry.columnGap) / (geometry.minCell + geometry.columnGap))));
  const rows = Math.max(1, Math.floor((height + geometry.rowGap) / (geometry.rowHeight + geometry.rowGap)));
  const shared = Math.floor((height - (rows - 1) * geometry.rowGap) / rows);
  const rowHeight = Math.max(geometry.rowHeight, Math.min(shared, Math.round(geometry.rowHeight * geometry.stretch)));
  return { columns, rows, rowHeight };
}

/** Whole rows of tiles that fit under the widgets on the first page. */
export function rowsBelow(pageHeight: number, taken: number, geometry: TileGeometry): number {
  if (taken <= 0) return Math.max(1, Math.floor((pageHeight + geometry.rowGap) / (geometry.rowHeight + geometry.rowGap)));
  return Math.max(0, Math.floor((pageHeight - taken + geometry.rowGap) / (geometry.rowHeight + geometry.rowGap)));
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const pages: T[][] = [];
  for (let index = 0; index < items.length; index += Math.max(1, size)) pages.push(items.slice(index, index + Math.max(1, size)));
  return pages.length > 0 ? pages : [[]];
}

/**
 * The pager's size, measured from its real layout. A width change (rotation,
 * split view) applies at once; a height loss only after it has lasted (the
 * soft keyboard comes and goes) — except just after mounting and just after
 * `layoutKey` changes, when the screen itself changed what surrounds the
 * pager (edit mode's taller footer, a card above it); a hidden or tiny
 * viewport is never measured.
 */
export function usePagerSize(pager: RefObject<HTMLElement | null>, layoutKey?: unknown): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const sizeRef = useRef({ width: 0, height: 0 });
  const promptUntil = useRef(0);
  useLayoutEffect(() => {
    promptUntil.current = Date.now() + PROMPT_WINDOW_MS;
  }, [layoutKey]);
  useLayoutEffect(() => {
    const element = pager.current;
    if (!element) return;
    let shrinkTimer = 0;
    const apply = (width: number, height: number) => {
      sizeRef.current = { width, height };
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    const measure = () => {
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (width < MIN_MEASURABLE || height < MIN_MEASURABLE) return;
      const previous = sizeRef.current;
      window.clearTimeout(shrinkTimer);
      if (previous.width === 0 || width !== previous.width || height >= previous.height || Date.now() < promptUntil.current) {
        apply(width, height);
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
  }, [pager]);
  return size;
}

export interface Paging {
  page: number;
  goTo: (page: number, options?: { animate?: boolean }) => void;
  /** Call from the pager's scroll handler. */
  onScroll: () => void;
}

/**
 * Which page is on show. The current page survives every re-layout (the same
 * page at a new width), falling back to the last page that still exists.
 */
export function usePageTracking(pager: RefObject<HTMLElement | null>, count: number, width: number): Paging {
  const [page, setPage] = useState(0);
  const pageRef = useRef(0);
  const programmatic = useRef(0);

  // A new width: stay on the same page.
  useLayoutEffect(() => {
    const element = pager.current;
    if (element && width > 0) element.scrollLeft = pageRef.current * element.clientWidth;
  }, [pager, width]);

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

  return { page, goTo, onScroll };
}
