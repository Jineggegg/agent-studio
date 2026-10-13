import { useSyncExternalStore } from 'react';

/**
 * The three layout classes. They depend on the viewport width and nothing
 * else — not the device, not the orientation, not the pointer type — so a
 * tablet in a narrow split view is a phone, and a phone browser stretched
 * across a desktop is wide.
 */
export type LayoutClass = 'phone' | 'tablet' | 'wide';

export const PHONE_MAX_WIDTH = 699;
export const TABLET_MAX_WIDTH = 1023;

export function layoutClassForWidth(width: number): LayoutClass {
  if (width <= PHONE_MAX_WIDTH) return 'phone';
  if (width <= TABLET_MAX_WIDTH) return 'tablet';
  return 'wide';
}

function read(): LayoutClass {
  if (typeof window === 'undefined') return 'wide';
  return layoutClassForWidth(window.innerWidth);
}

let current: LayoutClass = read();
const listeners = new Set<() => void>();
let attached = false;

function update(): void {
  const next = read();
  // Stylesheets key off this attribute, so CSS and components can never disagree.
  if (document.documentElement.dataset.layout !== next) document.documentElement.dataset.layout = next;
  if (next === current) return;
  current = next;
  for (const listener of [...listeners]) listener();
}

function attach(): void {
  if (attached || typeof window === 'undefined') return;
  attached = true;
  window.addEventListener('resize', update, { passive: true });
  window.addEventListener('orientationchange', update, { passive: true });
  update();
}

function subscribe(listener: () => void): () => void {
  attach();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): LayoutClass {
  if (!attached) current = read();
  return current;
}

/**
 * The current layout class, re-evaluated on resize, rotation and split view.
 * Every surface that lays out differently by size uses this hook (or the
 * matching `[data-layout]` attribute in CSS) — never its own breakpoint.
 */
export function useLayoutClass(): LayoutClass {
  return useSyncExternalStore(subscribe, getSnapshot, () => 'wide');
}

/** Start tracking before the first component asks, so `data-layout` is right from the first frame. */
export function startLayoutTracking(): void {
  attach();
}

/** The layout class right now, for code outside React. */
export function getLayoutClass(): LayoutClass {
  return getSnapshot();
}
