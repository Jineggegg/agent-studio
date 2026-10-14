import type { AttachmentRef } from '@agent-studio/protocol';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '@/i18n';
import { OverlayPortal, focusableWithin, useOverlayLayer } from '@/ui/overlay';

export interface ImageViewerProps {
  images: readonly Pick<AttachmentRef, 'id' | 'name' | 'url'>[];
  index: number;
  open: boolean;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}

const MAX_SCALE = 6;
const DOUBLE_TAP_SCALE = 2.5;

interface View {
  scale: number;
  x: number;
  y: number;
}

const REST: View = { scale: 1, x: 0, y: 0 };

/**
 * A picture, full screen. Pinch, wheel or double tap to zoom; drag to pan;
 * swipe sideways (or use the arrow keys) for the next one; swipe down, press
 * Escape or use the close button to leave. Focus returns to the thumbnail.
 */
export function ImageViewer({ images, index, open, onClose, onIndexChange }: ImageViewerProps) {
  if (!open || images.length === 0) return null;
  return <Viewer images={images} index={Math.min(index, images.length - 1)} onClose={onClose} onIndexChange={onIndexChange} />;
}

function Viewer({ images, index, onClose, onIndexChange }: Omit<ImageViewerProps, 'open'>) {
  const t = useT();
  const layer = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [view, setView] = useState<View>(REST);
  const [drag, setDrag] = useState(0);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ startX: number; startY: number; origin: View; distance: number; moved: boolean; lastTap: number } | null>(null);
  const lastTap = useRef(0);
  const image = images[index]!;

  useLayoutEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, []);
  useOverlayLayer(true, onClose);
  useLayoutEffect(() => {
    const element = layer.current;
    if (element) (focusableWithin(element)[0] ?? element).focus({ preventScroll: true });
    return () => {
      const previous = opener.current;
      if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, []);

  const go = useCallback(
    (step: number) => {
      const next = index + step;
      if (next < 0 || next >= images.length) return;
      setView(REST);
      onIndexChange(next);
    },
    [index, images.length, onIndexChange],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight') go(1);
      else if (event.key === 'ArrowLeft') go(-1);
      else if (event.key === 'Tab') {
        const element = layer.current;
        if (!element) return;
        const items = focusableWithin(element);
        const at = items.indexOf(document.activeElement as HTMLElement);
        event.preventDefault();
        items[(at + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [go]);

  const clamp = (next: View): View => {
    const scale = Math.min(MAX_SCALE, Math.max(1, next.scale));
    if (scale === 1) return REST;
    const element = layer.current;
    const limitX = ((element?.clientWidth ?? 0) * (scale - 1)) / 2;
    const limitY = ((element?.clientHeight ?? 0) * (scale - 1)) / 2;
    return { scale, x: Math.min(limitX, Math.max(-limitX, next.x)), y: Math.min(limitY, Math.max(-limitY, next.y)) };
  };

  const spread = (): number => {
    const [a, b] = [...pointers.current.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as Element).closest('button, a')) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture?.(event.pointerId);
    gesture.current = { startX: event.clientX, startY: event.clientY, origin: view, distance: spread(), moved: false, lastTap: lastTap.current };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    if (!state || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size >= 2) {
      const distance = spread();
      if (state.distance > 0) setView(clamp({ ...state.origin, scale: state.origin.scale * (distance / state.distance) }));
      state.moved = true;
      return;
    }
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) state.moved = true;
    if (state.origin.scale > 1) setView(clamp({ scale: state.origin.scale, x: state.origin.x + dx, y: state.origin.y + dy }));
    else setDrag(Math.abs(dy) > Math.abs(dx) ? Math.max(0, dy) : 0);
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = gesture.current;
    const wasMulti = pointers.current.size >= 2;
    pointers.current.delete(event.pointerId);
    if (!state || pointers.current.size > 0) return;
    gesture.current = null;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    setDrag(0);
    if (wasMulti || event.type === 'pointercancel') return;
    if (!state.moved) {
      const now = event.timeStamp;
      if (now - state.lastTap < 320) {
        lastTap.current = 0;
        setView(view.scale > 1 ? REST : { scale: DOUBLE_TAP_SCALE, x: 0, y: 0 });
      } else {
        lastTap.current = now;
      }
      return;
    }
    if (state.origin.scale > 1) return;
    if (dy > 110 && Math.abs(dy) > Math.abs(dx) * 1.4) onClose();
    else if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.4) go(dx < 0 ? 1 : -1);
  };

  return (
    <OverlayPortal>
      <div
        ref={layer}
        className="wb-viewer"
        data-overlay=""
        role="dialog"
        aria-modal="true"
        aria-label={t('workbench.viewer.title', { name: image.name })}
        tabIndex={-1}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={(event) => setView(clamp({ ...view, scale: view.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15) }))}
      >
        <div className="wb-viewer__bar">
          <button type="button" className="wb-viewer__button" onClick={onClose} aria-label={t('common.close')} title={t('common.close')}>
            <X size={22} aria-hidden="true" />
          </button>
          <span className="wb-viewer__name u-truncate">
            {image.name}
            {images.length > 1 && <span className="u-tabular"> · {t('workbench.viewer.position', { index: t.number(index + 1), total: t.number(images.length) })}</span>}
          </span>
          <a className="wb-viewer__button" href={image.url} download={image.name} aria-label={t('workbench.viewer.download')} title={t('workbench.viewer.download')}>
            <Download size={20} aria-hidden="true" />
          </a>
        </div>
        <img
          key={image.id}
          className="wb-viewer__image"
          src={image.url}
          alt={image.name}
          draggable={false}
          style={{ transform: `translate3d(${view.x}px, ${view.y + drag}px, 0) scale(${view.scale})`, opacity: drag > 0 ? Math.max(0.4, 1 - drag / 400) : 1 }}
          data-moving={gesture.current ? '' : undefined}
        />
        {images.length > 1 && (
          <>
            <button type="button" className="wb-viewer__button wb-viewer__nav" data-side="previous" disabled={index === 0} onClick={() => go(-1)} aria-label={t('workbench.viewer.previous')}>
              <ChevronLeft size={24} aria-hidden="true" />
            </button>
            <button type="button" className="wb-viewer__button wb-viewer__nav" data-side="next" disabled={index === images.length - 1} onClick={() => go(1)} aria-label={t('workbench.viewer.next')}>
              <ChevronRight size={24} aria-hidden="true" />
            </button>
          </>
        )}
      </div>
    </OverlayPortal>
  );
}
