import { type RefObject, useLayoutEffect, useRef } from 'react';
import { prefersReducedMotion } from '@/platform/media';

/**
 * Neighbours glide instead of jumping: after every render in which the order
 * changed, each `[data-flip-id]` element inside `container` that moved within
 * its own page is animated from where it was to where it is now. Positions
 * are measured relative to the page, so turning pages animates nothing; under
 * reduced motion nothing moves at all.
 */
export function useFlip(container: RefObject<HTMLElement | null>, orderKey: string): void {
  const last = useRef(new Map<string, { page: string; left: number; top: number }>());
  useLayoutEffect(() => {
    const root = container.current;
    if (!root) return;
    const next = new Map<string, { page: string; left: number; top: number }>();
    const reduce = prefersReducedMotion();
    for (const element of root.querySelectorAll<HTMLElement>('[data-flip-id]')) {
      const id = element.dataset.flipId!;
      const page = element.closest<HTMLElement>('[data-page]')?.dataset.page ?? '';
      const position = { page, left: element.offsetLeft, top: element.offsetTop };
      next.set(id, position);
      const before = last.current.get(id);
      if (reduce || !before || before.page !== page) continue;
      const dx = before.left - position.left;
      const dy = before.top - position.top;
      if (dx === 0 && dy === 0) continue;
      if (typeof element.animate !== 'function') continue;
      element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
    }
    last.current = next;
  }, [container, orderKey]);
}
