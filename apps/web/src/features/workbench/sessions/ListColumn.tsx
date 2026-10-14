import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { LIST_DEFAULT_WIDTH, LIST_MIN_WIDTH, setListWidth } from '../device';

/** One press of ← or → on the handle. */
export const LIST_KEY_STEP = 24;

export interface ListColumnProps {
  /** The width to draw, already fitted to the space there is. */
  width: number;
  /** How wide it may be made right now. */
  maxWidth: number;
  children: ReactNode;
}

/**
 * The docked conversation list, with a handle on its trailing edge that makes
 * it wider or narrower: dragged (mouse, pen or finger), with ← and → when
 * focused, or back to the default with a double click.
 *
 * While a drag lasts, the width lives here and only this column is drawn
 * again — the list inside is the same element throughout, so it is not
 * re-rendered — and the result is remembered when the pointer lets go.
 */
export function ListColumn({ width, maxWidth, children }: ListColumnProps) {
  const t = useT();
  const max = Math.max(LIST_MIN_WIDTH, maxWidth);
  const fit = (value: number) => Math.min(max, Math.max(LIST_MIN_WIDTH, Math.round(value)));
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const drag = useRef<{ id: number; startX: number; startWidth: number; width: number | null } | null>(null);
  const shown = dragWidth ?? width;

  const onDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    drag.current = { id: event.pointerId, startX: event.clientX, startWidth: width, width: null };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    // No text selection starts, and a touch does not scroll the page instead.
    event.preventDefault();
  };
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    // The list is at the leading edge: dragging towards the trailing edge widens it.
    current.width = fit(current.startWidth + (event.clientX - current.startX));
    setDragWidth(current.width);
  };
  const onUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    // A cancelled pointer (the system took the touch over) keeps where the drag had got to, as a release would.
    if (current.width !== null) setListWidth(current.width);
    setDragWidth(null);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = width - LIST_KEY_STEP;
    else if (event.key === 'ArrowRight') next = width + LIST_KEY_STEP;
    else if (event.key === 'Home') next = LIST_MIN_WIDTH;
    else if (event.key === 'End') next = max;
    if (next === null) return;
    event.preventDefault();
    setListWidth(fit(next));
  };

  return (
    <nav className="wb__list" style={{ width: shown }} data-dragging={dragWidth !== null || undefined} aria-label={t('workbench.list.title')}>
      {children}
      <div
        className="wb__list-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('workbench.list.resize')}
        aria-valuemin={LIST_MIN_WIDTH}
        aria-valuemax={max}
        aria-valuenow={Math.round(shown)}
        title={t('workbench.list.resizeHint')}
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onLostPointerCapture={onUp}
        onDoubleClick={() => setListWidth(LIST_DEFAULT_WIDTH)}
        onKeyDown={onKeyDown}
      />
    </nav>
  );
}
