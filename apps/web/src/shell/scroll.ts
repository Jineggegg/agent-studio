import { type RefObject, useLayoutEffect } from 'react';
import { useScreen } from './ScreenStack';

/**
 * Scroll positions, remembered per history entry. Every screen scrolls inside
 * its own container (the document never scrolls), so the browser's own
 * restoration cannot help; this does the same job.
 */
const positions = new Map<string, number>();
const STORAGE_KEY = 'studio.scroll';
const MAX_REMEMBERED = 80;
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    for (const [key, value] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) {
      if (typeof value === 'number') positions.set(key, value);
    }
  } catch {
    /* ignore */
  }
  window.addEventListener('pagehide', () => {
    try {
      const recent = [...positions.entries()].slice(-MAX_REMEMBERED);
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(recent)));
    } catch {
      /* ignore */
    }
  });
}

/**
 * Remember the scroll offset of `ref` for the history entry this screen
 * belongs to, and put it back when the user returns to that entry. `id`
 * distinguishes several scroll areas on one screen.
 */
export function useScrollRestoration(ref: RefObject<HTMLElement | null>, id = 'main'): void {
  const screen = useScreen();
  const key = `${screen.location.key}:${id}`;

  useLayoutEffect(() => {
    load();
    const element = ref.current;
    if (!element) return;
    const saved = positions.get(key);
    let frame = 0;
    if (saved !== undefined && saved > 0) {
      element.scrollTop = saved;
      // Content that arrives a moment later (a list still rendering) may not be tall enough yet.
      let attempts = 0;
      const retry = () => {
        if (Math.abs(element.scrollTop - saved) <= 1 || attempts > 20) return;
        attempts += 1;
        element.scrollTop = saved;
        frame = window.requestAnimationFrame(retry);
      };
      frame = window.requestAnimationFrame(retry);
    }
    const onScroll = () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      positions.delete(key);
      positions.set(key, element.scrollTop);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      element.removeEventListener('scroll', onScroll);
    };
  }, [key, ref]);
}
