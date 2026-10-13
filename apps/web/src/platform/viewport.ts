import { type RefObject, useEffect, useSyncExternalStore } from 'react';

/**
 * Visual-viewport bookkeeping: the soft keyboard, and the installed-app
 * viewport quirks on iOS.
 *
 * The app root is `position: fixed` and sized from two custom properties this
 * module keeps current:
 *
 *   --app-height   height of the area the user can actually see
 *   --app-top      how far the browser has scrolled the layout viewport to
 *                  bring a focused field into view (iOS does this)
 *
 * Because the whole app is exactly as tall as what is visible, anything
 * docked to its bottom edge — a composer, a sheet's buttons — sits directly
 * above the keyboard without knowing the keyboard exists. When the keyboard
 * closes the properties return to full height and any leftover page scroll is
 * removed, so nothing stays displaced.
 */

export interface KeyboardState {
  /** True while the soft keyboard (or anything else) covers part of the layout viewport. */
  open: boolean;
  /** How many CSS px of the layout viewport are covered at the bottom. */
  inset: number;
}

/** Below this, a height difference is browser chrome settling, not a keyboard. */
const KEYBOARD_THRESHOLD = 120;

/**
 * In an installed iOS app the reported viewport can stop short of the true
 * screen edge (the status-bar inset is subtracted even though content is
 * allowed under it). Given what the browser reports, return the height a
 * full-screen layer should really use.
 */
export function correctedViewportHeight(input: {
  visualHeight: number;
  layoutHeight: number;
  screenWidth: number;
  screenHeight: number;
  viewportWidth: number;
  standalone: boolean;
  keyboardOpen: boolean;
}): number {
  const { visualHeight, layoutHeight, screenWidth, screenHeight, viewportWidth, standalone, keyboardOpen } = input;
  if (!standalone || keyboardOpen) return visualHeight;
  // `screen.*` does not rotate on iOS: pick the dimension that goes with the current orientation.
  const landscape = viewportWidth > Math.max(visualHeight, layoutHeight);
  const fullHeight = landscape ? Math.min(screenWidth, screenHeight) : Math.max(screenWidth, screenHeight);
  const shortfall = fullHeight - visualHeight;
  // A small shortfall is the quirk; a large one is something else (a keyboard we did not detect, a split view).
  return shortfall > 0 && shortfall <= 64 ? fullHeight : visualHeight;
}

let state: KeyboardState = { open: false, inset: 0 };
const listeners = new Set<() => void>();
let started = false;
let frame = 0;

function isEditable(element: Element | null): boolean {
  if (!element || !(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly;
  if (element instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'color', 'image'].includes(element.type) && !element.readOnly;
  }
  return false;
}

function measure(): void {
  frame = 0;
  const root = document.documentElement;
  const viewport = window.visualViewport;
  const layoutHeight = window.innerHeight;
  const visualHeight = viewport ? viewport.height : layoutHeight;
  const offsetTop = viewport ? viewport.offsetTop : 0;
  // A pinch-zoomed page reports a smaller visual viewport too; that is not a keyboard.
  const scale = viewport ? viewport.scale : 1;
  const zoomed = Math.abs(scale - 1) > 0.01;

  const covered = zoomed ? 0 : Math.max(0, Math.round(layoutHeight - visualHeight - offsetTop));
  const open = covered > KEYBOARD_THRESHOLD && isEditable(document.activeElement);
  const inset = open ? covered : 0;

  const height = zoomed
    ? layoutHeight
    : correctedViewportHeight({
        visualHeight,
        layoutHeight,
        screenWidth: window.screen?.width ?? 0,
        screenHeight: window.screen?.height ?? 0,
        viewportWidth: window.innerWidth,
        standalone: root.dataset.standalone === 'ios',
        keyboardOpen: covered > KEYBOARD_THRESHOLD,
      });

  root.style.setProperty('--app-height', `${Math.round(height * 100) / 100}px`);
  root.style.setProperty('--app-top', `${zoomed ? 0 : Math.max(0, Math.round(offsetTop))}px`);
  root.style.setProperty('--keyboard-inset', `${inset}px`);
  if (open) root.dataset.keyboard = 'open';
  else delete root.dataset.keyboard;

  if (!open && state.open) {
    // The keyboard just closed. iOS may leave the page scrolled; put it back.
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  }
  if (open !== state.open || inset !== state.inset) {
    state = { open, inset };
    for (const listener of [...listeners]) listener();
  }
}

function schedule(): void {
  if (frame) return;
  frame = window.requestAnimationFrame(measure);
}

/** Begin tracking. Called once at start-up; safe to call again. */
export function startViewportTracking(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const viewport = window.visualViewport;
  viewport?.addEventListener('resize', schedule);
  viewport?.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('orientationchange', schedule, { passive: true });
  // Focus moving out of a field is the earliest sign that the keyboard is going away.
  document.addEventListener('focusin', schedule);
  document.addEventListener('focusout', () => window.setTimeout(schedule, 60));
  // iOS: the document must never stay scrolled behind a fixed app.
  window.addEventListener(
    'scroll',
    () => {
      if (!state.open && (window.scrollY !== 0 || window.scrollX !== 0) && !isEditable(document.activeElement)) window.scrollTo(0, 0);
    },
    { passive: true },
  );
  measure();
}

function subscribe(listener: () => void): () => void {
  startViewportTracking();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the soft keyboard is up, and how much it covers. */
export function useKeyboard(): KeyboardState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/**
 * Keeps a docked element — a composer, a toolbar — usable while typing.
 *
 * The element itself needs no positioning help: dock it to the bottom of its
 * column and the shrinking app root carries it above the keyboard. This hook
 * adds the two things layout cannot: it keeps the focused field scrolled into
 * view inside the nearest scroll container when the keyboard arrives, and it
 * reports the keyboard so the component can drop its bottom safe-area padding
 * (the home indicator is under the keyboard then). Returns the keyboard state.
 *
 *   const dock = useRef<HTMLDivElement>(null);
 *   const keyboard = useKeyboardDock(dock);
 *   <div ref={dock} className="composer" data-keyboard={keyboard.open || undefined}>…</div>
 */
export function useKeyboardDock(ref: RefObject<HTMLElement | null>): KeyboardState {
  const keyboard = useKeyboard();
  useEffect(() => {
    if (!keyboard.open) return;
    const element = ref.current;
    const active = document.activeElement;
    if (!element || !(active instanceof HTMLElement)) return;
    // Only when the focus is ours; another field elsewhere looks after itself.
    if (!element.contains(active)) return;
    const timer = window.setTimeout(() => {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [keyboard.open, keyboard.inset, ref]);
  return keyboard;
}

/** For tests. */
export function __resetViewportForTests(): void {
  state = { open: false, inset: 0 };
  started = false;
}
