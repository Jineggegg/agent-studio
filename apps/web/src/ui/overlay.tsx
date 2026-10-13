import { type ReactNode, useEffect, useId, useLayoutEffect, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

/**
 * The stack of open overlays (sheets, dialogs, menus).
 *
 * Overlays never add a browser-history entry. They register here instead, so
 * that: only the topmost one answers Escape and holds focus; the page behind
 * can be made inert; and the rest of the app can ask "is anything open?"
 * (the back gesture and the automatic update both stand down while one is).
 */

interface Layer {
  id: string;
  onEscape: () => void;
}

let stack: Layer[] = [];
const listeners = new Set<() => void>();

/** The element holding everything that is not an overlay; made inert while one is open. */
export const APP_CONTENT_ID = 'app-content';

function emit(): void {
  // Done here, not through React state: whoever closes an overlay returns focus
  // to the page in the same breath, and focus cannot enter an inert subtree.
  if (typeof document !== 'undefined') {
    const content = document.getElementById(APP_CONTENT_ID);
    if (content) content.inert = stack.length > 0;
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let keyListenerAttached = false;
function attachKeyListener(): void {
  if (keyListenerAttached || typeof document === 'undefined') return;
  keyListenerAttached = true;
  // Capture phase: an open overlay gets Escape before anything behind it.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const top = stack[stack.length - 1];
      if (!top) return;
      event.preventDefault();
      event.stopPropagation();
      top.onEscape();
    },
    true,
  );
}

/** Whether any sheet, dialog or menu is open. */
export function isAnyOverlayOpen(): boolean {
  return stack.length > 0;
}

export function useAnyOverlayOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => stack.length > 0,
    () => false,
  );
}

/**
 * Registers an overlay while `active`. Returns whether it is the topmost one.
 * Call it before any effect that moves focus: the page behind stops being
 * inert in this hook's cleanup, and focus can only return after that.
 */
export function useOverlayLayer(active: boolean, onEscape: () => void): boolean {
  const id = useId();
  useLayoutEffect(() => {
    if (!active) return;
    attachKeyListener();
    stack = [...stack, { id, onEscape }];
    emit();
    return () => {
      stack = stack.filter((layer) => layer.id !== id);
      emit();
    };
    // `onEscape` is refreshed by the effect below so that re-renders do not reorder the stack.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, id]);

  useEffect(() => {
    const layer = stack.find((entry) => entry.id === id);
    if (layer) layer.onEscape = onEscape;
  });

  return useSyncExternalStore(
    subscribe,
    () => stack.length === 0 || stack[stack.length - 1]?.id === id,
    () => true,
  );
}

/** Renders children into the app's overlay layer (inside the app frame, so they follow the visual viewport). */
export function OverlayPortal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null;
  return createPortal(children, document.getElementById('overlay-root') ?? document.body);
}

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
].join(',');

/** The elements Tab can reach inside `container`, in order. */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => !element.closest('[inert]') && !element.closest('[hidden]') && element.getAttribute('aria-hidden') !== 'true',
  );
}

/** For tests. */
export function __resetOverlaysForTests(): void {
  stack = [];
  emit();
}
