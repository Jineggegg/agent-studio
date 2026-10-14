import { type ReactNode, type Ref, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import { type Anchor, type RowRange, type WindowLayout, computeLayout, padding, resolveScrollTop, visibleRange } from './windowing';

/**
 * A list that renders only the rows near the viewport, however long it is,
 * and behaves like a chat: it starts at the end, stays at the end while new
 * rows arrive — unless the reader has scrolled away, in which case what they
 * are looking at stays exactly where it is while rows above load or change
 * height.
 *
 * Rows are in normal flow between two paddings that stand in for the rows not
 * rendered, so a rendered row always has its true height; `windowing.ts` does
 * the arithmetic. Scroll position is corrected synchronously — in a layout
 * effect after React commits, and in the resize observer when a row changes
 * size by itself — so a correction is never visible as a jump.
 */
export interface WindowedListHandle {
  /** Go to the end and follow new rows again. */
  scrollToEnd(): void;
  /** Bring a row to the top of the view. False when there is no such row. */
  scrollToKey(key: string): boolean;
  isFollowing(): boolean;
}

export interface WindowedListProps<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  /** A guess at a row's height before it has been measured. */
  estimate: (item: T) => number;
  renderItem: (item: T, index: number) => ReactNode;
  /** Above the first row (a "loading earlier" line). */
  header?: ReactNode;
  /** Below the last row (the run status line). */
  footer?: ReactNode;
  /** The reader is close to the first row: the moment to load older ones. */
  onNearStart?: () => void;
  /** Whether the view is at the end and following. */
  onFollowChange?: (following: boolean) => void;
  label: string;
  className?: string;
  ref?: Ref<WindowedListHandle>;
}

const OVERSCAN = 900;
/** The rendered window is rebuilt when less than this is left of it beyond the viewport. */
const REFILL = 300;
const FOLLOW_THRESHOLD = 36;
const NEAR_START = 700;

export function WindowedList<T>({ items, getKey, estimate, renderItem, header, footer, onNearStart, onFollowChange, label, className, ref }: WindowedListProps<T>) {
  const scroller = useRef<HTMLDivElement>(null);
  const rowsElement = useRef<HTMLDivElement>(null);
  const footerElement = useRef<HTMLDivElement>(null);
  const [, rerender] = useReducer((count: number) => count + 1, 0);

  const heights = useRef(new Map<string, number>()).current;
  const nodes = useRef(new Map<string, HTMLElement>()).current;
  const following = useRef(true);
  const anchor = useRef<Anchor | null>(null);
  /** Scroll offset relative to the first row, as last seen in the DOM. */
  const lastTop = useRef(0);
  const viewport = useRef(typeof window === 'undefined' ? 800 : window.innerHeight);
  const footerHeight = useRef(0);
  const previousScrollTop = useRef(0);
  /** The next scroll event is the echo of a position we set ourselves. */
  const expectEcho = useRef(false);
  const callbacks = useRef({ onNearStart, onFollowChange });
  useEffect(() => {
    callbacks.current = { onNearStart, onFollowChange };
  });

  const keys = useMemo(() => items.map(getKey), [items, getKey]);
  const layout: WindowLayout = computeLayout(keys, heights, (index) => estimate(items[index]!));
  // Where the view will be once this render is on screen: the end, or wherever keeps the anchor in place.
  const virtualTop = resolveScrollTop({
    keys,
    // While following, the footer is part of what must fit above the bottom edge.
    layout: following.current ? { ...layout, total: layout.total + footerHeight.current } : layout,
    viewport: viewport.current,
    following: following.current,
    anchor: anchor.current,
    fallback: lastTop.current,
  });
  const range: RowRange = visibleRange(layout, virtualTop, viewport.current, OVERSCAN);
  const pad = padding(layout, range);

  const state = useRef({ keys, layout, range });
  state.current = { keys, layout, range };

  const setFollowing = useCallback((next: boolean) => {
    if (following.current === next) return;
    following.current = next;
    callbacks.current.onFollowChange?.(next);
  }, []);

  /** The first rendered row that is at least partly in view, and how far its top is from the top of the view. */
  const captureAnchor = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const { keys: currentKeys, range: currentRange } = state.current;
    for (let index = currentRange.start; index < currentRange.end; index += 1) {
      const key = currentKeys[index]!;
      const node = nodes.get(key);
      if (!node) continue;
      if (node.offsetTop + node.offsetHeight > element.scrollTop + 1) {
        anchor.current = { key, offset: node.offsetTop - element.scrollTop };
        return;
      }
    }
  }, [nodes]);

  /**
   * Measures what is rendered and puts the view where it belongs. Runs after
   * every commit and whenever a row, the footer or the viewport changes size.
   */
  const reconcile = useCallback(() => {
    const element = scroller.current;
    const rows = rowsElement.current;
    if (!element || !rows) return;
    let changed = false;
    for (const [key, node] of nodes) {
      const height = node.getBoundingClientRect().height;
      if (height > 0 && Math.abs((heights.get(key) ?? -1) - height) > 0.5) {
        heights.set(key, height);
        changed = true;
      }
    }
    if (Math.abs(viewport.current - element.clientHeight) > 0.5 && element.clientHeight > 0) {
      viewport.current = element.clientHeight;
      changed = true;
    }
    footerHeight.current = footerElement.current?.offsetHeight ?? 0;

    let target: number | null = null;
    if (following.current) {
      target = element.scrollHeight - element.clientHeight;
    } else if (anchor.current) {
      const node = nodes.get(anchor.current.key);
      if (node) target = node.offsetTop - anchor.current.offset;
    }
    if (target !== null) {
      const clamped = Math.max(0, Math.min(target, element.scrollHeight - element.clientHeight));
      if (Math.abs(element.scrollTop - clamped) > 0.5) {
        expectEcho.current = true;
        element.scrollTop = clamped;
      }
    }
    previousScrollTop.current = element.scrollTop;
    lastTop.current = element.scrollTop - rows.offsetTop;
    if (changed) rerender();
    if (element.scrollTop < NEAR_START) callbacks.current.onNearStart?.();
  }, [heights, nodes]);

  // No dependency list on purpose: every commit may have changed what is rendered.
  useLayoutEffect(() => {
    reconcile();
  });

  useEffect(() => {
    const element = scroller.current;
    const rows = rowsElement.current;
    if (!element || !rows || typeof ResizeObserver === 'undefined') return;
    // The rows' container changes height whenever any row does: one observation covers them all.
    const observer = new ResizeObserver(() => reconcile());
    observer.observe(element);
    observer.observe(rows);
    if (footerElement.current) observer.observe(footerElement.current);
    return () => observer.disconnect();
  }, [reconcile]);

  const onScroll = () => {
    const element = scroller.current;
    const rows = rowsElement.current;
    if (!element || !rows) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    const movedUp = element.scrollTop < previousScrollTop.current - 1;
    const echo = expectEcho.current;
    expectEcho.current = false;
    previousScrollTop.current = element.scrollTop;

    if (distance <= 2) setFollowing(true);
    else if (!echo && movedUp) setFollowing(false);
    else if (!echo && distance <= FOLLOW_THRESHOLD) setFollowing(true);

    if (!following.current) captureAnchor();
    lastTop.current = element.scrollTop - rows.offsetTop;

    // Render again only when the view is running out of rendered rows.
    const { layout: currentLayout, range: currentRange } = state.current;
    const needed = visibleRange(currentLayout, lastTop.current, element.clientHeight, REFILL);
    if (needed.start < currentRange.start || needed.end > currentRange.end) rerender();
    if (element.scrollTop < NEAR_START) callbacks.current.onNearStart?.();
  };

  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd() {
        anchor.current = null;
        setFollowing(true);
        rerender();
      },
      scrollToKey(key) {
        if (!state.current.keys.includes(key)) return false;
        setFollowing(false);
        anchor.current = { key, offset: 12 };
        rerender();
        return true;
      },
      isFollowing: () => following.current,
    }),
    [setFollowing],
  );

  const register = useCallback(
    (key: string) => (node: HTMLDivElement | null) => {
      if (node) nodes.set(key, node);
      else nodes.delete(key);
    },
    [nodes],
  );

  return (
    <div ref={scroller} className={className ? `wb-window ${className}` : 'wb-window'} onScroll={onScroll} tabIndex={0} role="region" aria-label={label}>
      {header}
      <div ref={rowsElement} className="wb-window__rows" style={{ paddingTop: pad.before, paddingBottom: pad.after }}>
        {items.slice(range.start, range.end).map((item, offset) => {
          const index = range.start + offset;
          const key = keys[index]!;
          return (
            <div key={key} ref={register(key)} className="wb-window__row" data-row-key={key}>
              {renderItem(item, index)}
            </div>
          );
        })}
      </div>
      <div ref={footerElement} className="wb-window__footer">
        {footer}
      </div>
    </div>
  );
}
