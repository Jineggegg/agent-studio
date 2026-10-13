import { useSyncExternalStore } from 'react';

/** Subscribes a component to a media query. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener('change', listener);
      return () => list.removeEventListener('change', listener);
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export const useReducedMotion = (): boolean => useMediaQuery('(prefers-reduced-motion: reduce)');

/** True on devices whose main pointer can hover (mouse, trackpad): the place for tooltips and shortcut hints. */
export const useCanHover = (): boolean => useMediaQuery('(hover: hover) and (pointer: fine)');

/** Whether the page is on screen. Polling and decorative motion stop while it is not. */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    () => document.visibilityState !== 'hidden',
    () => true,
  );
}

/** The browser's own idea of being online. Unreliable as proof of reaching the server; good enough for a hint. */
export function useBrowserOnline(): boolean {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener('online', listener);
      window.addEventListener('offline', listener);
      return () => {
        window.removeEventListener('online', listener);
        window.removeEventListener('offline', listener);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

export const isApplePlatform = (): boolean =>
  typeof navigator !== 'undefined' && (/Mac|iPhone|iPad|iPod/.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent));
