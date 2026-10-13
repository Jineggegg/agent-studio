import { X } from 'lucide-react';
import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { useT } from '@/i18n';
import { useLayoutClass } from '@/platform/layout';
import { IconButton } from './Button';
import { OverlayPortal, focusableWithin, useOverlayLayer } from './overlay';

export interface SheetProps {
  open: boolean;
  /** Asked to close: the close control, the backdrop, Escape, or a drag. Set `open` to false in answer. */
  onClose: () => void;
  /** Names the sheet for assistive technology and shows in its header. */
  title: string;
  /** Keep the title for assistive technology only (the content has its own heading). */
  hideTitle?: boolean;
  children: ReactNode;
  /** Buttons pinned under the content. On a phone they stack, full width, primary on top. */
  footer?: ReactNode;
  /** Header's leading slot — typically a plain "Cancel" button. */
  leading?: ReactNode;
  /** Header's trailing slot — typically "Done" / "Save". Defaults to a close button. */
  trailing?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Phone only: take the full height instead of hugging the content. */
  fill?: boolean;
  /** No padding around the content (for lists that run edge to edge). */
  flush?: boolean;
  /** False while something is in flight: Escape, the backdrop and dragging are ignored. Default true. */
  dismissible?: boolean;
  /** `alertdialog` for a question that must be answered. */
  role?: 'dialog' | 'alertdialog';
  /** What to focus on opening. Default: the first `[data-autofocus]`, else the first field, else the sheet itself. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Force one presentation. Default: bottom sheet on phone, dialog on tablet and wide. */
  presentation?: 'auto' | 'sheet' | 'dialog';
  /** A lighter backdrop, for menus that should not darken the page much. */
  scrim?: 'default' | 'light';
  /** Called after the exit has played and the sheet has left the document. */
  onClosed?: () => void;
  className?: string;
}

const EXIT_MS = 260;

/**
 * One content definition, two presentations: a bottom sheet with
 * drag-to-dismiss on a phone, a centred dialog on wider screens.
 *
 * Focus moves in on opening, Tab cycles inside, Escape and the backdrop
 * close it, and focus returns to whatever opened it. It plays its exit before
 * leaving and takes no input while doing so. It adds no history entry.
 */
export function Sheet({
  open,
  onClose,
  title,
  hideTitle,
  children,
  footer,
  leading,
  trailing,
  size = 'md',
  fill,
  flush,
  dismissible = true,
  role = 'dialog',
  initialFocus,
  presentation = 'auto',
  scrim = 'default',
  onClosed,
  className,
}: SheetProps) {
  const t = useT();
  const layout = useLayoutClass();
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const [divided, setDivided] = useState(false);

  // Derive the exit phase from `open` during render, so there is never a frame without the sheet.
  if (open && (!mounted || closing)) {
    if (!mounted) setMounted(true);
    if (closing) setClosing(false);
  } else if (!open && mounted && !closing) {
    setClosing(true);
  }

  const asSheet = presentation === 'sheet' || (presentation === 'auto' && layout === 'phone');
  const active = mounted && !closing;

  const requestClose = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);

  // Remember who opened us — before the page behind turns inert and loses its focus.
  // `live` goes false in this effect's cleanup, the first to run when closing starts, so that
  // nothing below (the focus guard in particular) fights the hand-back of focus.
  const live = useRef(false);
  useLayoutEffect(() => {
    if (!active) return;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    live.current = true;
    return () => {
      live.current = false;
    };
  }, [active]);

  const isTop = useOverlayLayer(active, requestClose);

  // Focus moves in on opening and is handed back the moment closing begins, so the keyboard is never
  // left inside a leaving layer. The hand-back happens in the effect body, not in a cleanup: React
  // restores the previously focused element after its mutation phase, which would undo a cleanup's work.
  const returnFocus = useCallback(() => {
    const previous = opener.current;
    opener.current = null;
    if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    if (!active) {
      returnFocus();
      return;
    }
    const element = panel.current;
    if (!element) return;
    const target =
      initialFocus?.current ??
      element.querySelector<HTMLElement>('[data-autofocus]') ??
      element.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]):not([hidden]), textarea:not([disabled])') ??
      element;
    target.focus({ preventScroll: true });
    // `initialFocus` is read once on opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
  // Removed from the tree while still open: there is no "closing" phase, so hand focus back here.
  useLayoutEffect(() => returnFocus, [returnFocus]);

  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => {
      setMounted(false);
      setClosing(false);
      onClosed?.();
    }, EXIT_MS);
    return () => window.clearTimeout(timer);
    // `onClosed` belongs to this one exit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closing]);

  // Focus must not escape to the page behind (a script moving it, a screen-reader gesture).
  useEffect(() => {
    if (!active || !isTop) return;
    const onFocusIn = (event: FocusEvent) => {
      const element = panel.current;
      const target = event.target;
      if (!live.current || !element || !(target instanceof Node) || element.contains(target)) return;
      // Focus inside another overlay (one that has just opened above this one) is that overlay's business.
      const otherLayer = target instanceof Element ? target.closest('[data-overlay]') : null;
      if (otherLayer && otherLayer !== element.closest('[data-overlay]')) return;
      (focusableWithin(element)[0] ?? element).focus({ preventScroll: true });
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, [active, isTop]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const element = panel.current;
    if (!element) return;
    const items = focusableWithin(element);
    if (items.length === 0) {
      event.preventDefault();
      element.focus();
      return;
    }
    const first = items[0]!;
    const last = items[items.length - 1]!;
    const current = document.activeElement;
    if (event.shiftKey && (current === first || current === element)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && current === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // ---- drag to dismiss (bottom sheet only) ----------------------------------
  const drag = useRef<{ id: number; startY: number; lastY: number; lastTime: number; velocity: number } | null>(null);

  const onDragStart = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!asSheet || !dismissible || !active) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if ((event.target as Element).closest('button, a, input, textarea, select, [role="button"]')) return;
    drag.current = { id: event.pointerId, startY: event.clientY, lastY: event.clientY, lastTime: event.timeStamp, velocity: 0 };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onDragMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    const element = panel.current;
    if (!state || state.id !== event.pointerId || !element) return;
    const delta = event.clientY - state.startY;
    const elapsed = Math.max(1, event.timeStamp - state.lastTime);
    state.velocity = (event.clientY - state.lastY) / elapsed;
    state.lastY = event.clientY;
    state.lastTime = event.timeStamp;
    // Follows the finger down; resists being pulled up past its resting place.
    const offset = delta >= 0 ? delta : delta / 6;
    element.dataset.dragging = '';
    element.style.transform = `translateY(${offset}px)`;
  };
  const onDragEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    const element = panel.current;
    if (!state || state.id !== event.pointerId || !element) return;
    drag.current = null;
    const delta = event.clientY - state.startY;
    delete element.dataset.dragging;
    element.dataset.settling = '';
    const dismiss = event.type !== 'pointercancel' && (delta > Math.min(160, element.offsetHeight * 0.33) || (delta > 24 && state.velocity > 0.55));
    if (dismiss) {
      element.style.transform = 'translateY(100%)';
      onClose();
      return;
    }
    element.style.transform = '';
    window.setTimeout(() => delete element.dataset.settling, 260);
  };
  const dragHandlers = asSheet
    ? { onPointerDown: onDragStart, onPointerMove: onDragMove, onPointerUp: onDragEnd, onPointerCancel: onDragEnd }
    : {};

  if (!mounted) return null;

  return (
    <OverlayPortal>
      <div
        className="ui-sheet-layer"
        data-overlay=""
        data-state={closing ? 'closing' : 'open'}
        data-presentation={asSheet ? 'sheet' : 'dialog'}
        data-scrim={scrim}
        inert={closing}
      >
        <div className="ui-sheet__scrim" onClick={requestClose} aria-hidden="true" />
        <div
          ref={panel}
          className={className ? `ui-sheet ${className}` : 'ui-sheet'}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          data-size={size}
          data-fill={fill || undefined}
          onKeyDown={onKeyDown}
        >
          <div className="ui-sheet__grabber" aria-hidden="true" {...dragHandlers} />
          {hideTitle && !leading && !trailing ? (
            <h2 id={titleId} className="visually-hidden">
              {title}
            </h2>
          ) : (
            <header className="ui-sheet__header" data-divided={divided || undefined} {...dragHandlers}>
              <div className="ui-sheet__header-leading">{leading}</div>
              <h2 id={titleId} className={hideTitle ? 'visually-hidden' : 'ui-sheet__title'}>
                {title}
              </h2>
              <div className="ui-sheet__header-trailing">
                {trailing ?? <IconButton label={t('common.close')} icon={<X size={20} />} variant="filled" tone="secondary" onClick={requestClose} />}
              </div>
            </header>
          )}
          <div
            className="ui-sheet__body"
            data-flush={flush || undefined}
            onScroll={(event) => {
              const scrolled = event.currentTarget.scrollTop > 2;
              if (scrolled !== divided) setDivided(scrolled);
            }}
          >
            {children}
          </div>
          {footer && <footer className="ui-sheet__footer">{footer}</footer>}
        </div>
      </div>
    </OverlayPortal>
  );
}
