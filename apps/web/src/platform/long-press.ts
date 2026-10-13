import { type PointerEvent as ReactPointerEvent, useRef } from 'react';

export interface LongPressOptions {
  /** How long the finger must rest, in ms. Default 450. */
  delay?: number;
  /** How far it may wander meanwhile, in CSS px. Default 8. */
  tolerance?: number;
}

export interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent) => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: (event: ReactPointerEvent) => void;
  onPointerCancel: (event: ReactPointerEvent) => void;
  onPointerLeave: (event: ReactPointerEvent) => void;
  onClickCapture: (event: React.MouseEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}

/**
 * Long press, done properly: it fires after a still hold, the click that
 * ends the press is swallowed (so the item is not also activated), and the
 * system's own long-press menu is suppressed. A right-click or the keyboard's
 * context-menu key does the same thing, so nothing depends on touch.
 *
 * Give the element the `u-no-callout` class as well, to stop text selection
 * and link previews.
 */
export function useLongPress(onLongPress: () => void, { delay = 450, tolerance = 8 }: LongPressOptions = {}): LongPressHandlers {
  const state = useRef<{ timer: number; x: number; y: number; fired: boolean } | null>(null);
  const swallow = useRef(false);

  const cancel = () => {
    if (state.current) window.clearTimeout(state.current.timer);
    state.current = null;
  };

  return {
    onPointerDown(event) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      cancel();
      swallow.current = false;
      const record = {
        x: event.clientX,
        y: event.clientY,
        fired: false,
        timer: window.setTimeout(() => {
          record.fired = true;
          swallow.current = true;
          if (typeof navigator.vibrate === 'function') navigator.vibrate(8);
          onLongPress();
        }, delay),
      };
      state.current = record;
    },
    onPointerMove(event) {
      const record = state.current;
      if (!record || record.fired) return;
      if (Math.hypot(event.clientX - record.x, event.clientY - record.y) > tolerance) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onClickCapture(event) {
      if (!swallow.current) return;
      swallow.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu(event) {
      event.preventDefault();
      // A touch long-press raises contextmenu too; the timer has already handled it.
      if (swallow.current || state.current?.fired) return;
      cancel();
      onLongPress();
    },
  };
}
