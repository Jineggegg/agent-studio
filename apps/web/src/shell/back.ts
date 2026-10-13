import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router';
import { useT } from '@/i18n';
import { isApplePlatform } from '@/platform/media';
import { isAnyOverlayOpen } from '@/ui/overlay';
import { useScreen } from './ScreenStack';
import { entryBefore, historyVersion, subscribeHistory } from './history';

/**
 * "Back", in one place.
 *
 * The control in the navigation bar, Escape, ⌘[ / Ctrl+[ and a swipe from the
 * left edge all call the same function, so they can never disagree about
 * where back goes:
 *
 *  - when the user came here from another page of the app, back returns there;
 *  - otherwise (a deep link, a cold start) it goes to the screen's parent, and
 *    replaces the history entry so the browser's back button cannot loop.
 *
 * Overlays are not part of this: they add no history and close themselves.
 */

export interface ParentScreen {
  /** Where back goes when there is nothing behind this screen in history. */
  to: string;
  /** What that place is called. */
  label: string;
}

export interface BackAction {
  /** Names the destination. */
  label: string;
  accessibleLabel: string;
  go: () => void;
}

interface Registration {
  depth: number;
  order: number;
  go: () => void;
}

const registrations = new Set<Registration>();
let order = 0;
/** Set while our own code asked for a history pop, so the transition knows it was not a system gesture. */
let expectedPopUntil = 0;
let lastEdgeTouchAt = 0;

function topRegistration(): Registration | null {
  let top: Registration | null = null;
  for (const registration of registrations) {
    if (!top || registration.depth > top.depth || (registration.depth === top.depth && registration.order > top.order)) top = registration;
  }
  return top;
}

/** Do what the visible back control would do. Returns false when the screen on show has no "back". */
export function performBack(): boolean {
  const top = topRegistration();
  if (!top) return false;
  top.go();
  return true;
}

/**
 * True when the history pop being handled right now was most likely driven by
 * a system gesture that has already animated the page (an edge swipe in a
 * mobile browser). Animating again would play the transition twice.
 */
export function isSystemGesturePop(): boolean {
  const now = Date.now();
  return now > expectedPopUntil && now - lastEdgeTouchAt < 1200;
}

/**
 * The back action of the screen this component is in. `parent` is the fallback
 * destination; pass null on a root screen (no back at all).
 *
 * `fallback: true` registers at the lowest priority: it answers the keyboard
 * and the edge swipe only while no real screen does — which is exactly the
 * time a route's code is still downloading, or has failed to. Without it
 * those moments would be dead ends.
 */
export function useBack(parent: ParentScreen | null, options: { fallback?: boolean } = {}): BackAction | null {
  const t = useT();
  const navigate = useNavigate();
  const screen = useScreen();
  useSyncExternalStore(subscribeHistory, historyVersion, historyVersion);

  const key = screen.location.key;
  const previous = parent ? entryBefore(key) : null;
  const parentTo = parent?.to;

  const go = useCallback(() => {
    if (parentTo === undefined) return;
    if (entryBefore(key)) {
      expectedPopUntil = Date.now() + 800;
      void navigate(-1);
    } else {
      void navigate(parentTo, { replace: true });
    }
  }, [key, navigate, parentTo]);

  // The topmost active screen answers the keyboard and the edge swipe.
  const goRef = useRef(go);
  useEffect(() => {
    goRef.current = go;
  });
  const hasBack = parent !== null;
  const fallback = options.fallback === true;
  useEffect(() => {
    if (!screen.active || !hasBack) return;
    const registration: Registration = { depth: fallback ? screen.depth - 0.5 : screen.depth, order: (order += 1), go: () => goRef.current() };
    registrations.add(registration);
    return () => {
      registrations.delete(registration);
    };
  }, [screen.active, screen.depth, hasBack, fallback]);

  if (!parent) return null;
  const label = previous?.title ?? parent.label;
  const goesHome = (previous?.pathname ?? parent.to) === '/';
  return { label, accessibleLabel: goesHome ? t('nav.backToHome') : t('nav.backTo', { name: label }), go };
}

// ---- keyboard ------------------------------------------------------------------

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Editors and terminals keep their own keys (set `data-keys="own"` on any surface that needs the same). */
function ownsKeys(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.cm-editor, .xterm, [data-keys="own"]') !== null;
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.defaultPrevented || event.repeat || isAnyOverlayOpen() || ownsKeys(event.target)) return;
  const chord = event.key === '[' && (isApplePlatform() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.altKey && !event.shiftKey;
  const freeEscape = event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !isTypingTarget(event.target);
  if (!chord && !freeEscape) return;
  if (performBack()) event.preventDefault();
}

// ---- left-edge swipe -----------------------------------------------------------

const EDGE_WIDTH = 20;
const TRIGGER_DISTANCE = 72;
const MAX_DRIFT = 50;

interface Swipe {
  id: number;
  startX: number;
  startY: number;
  key: string;
  armed: boolean;
}

let swipe: Swipe | null = null;
let indicator: HTMLDivElement | null = null;
let currentLocationKey: () => string = () => '';

function scrollsSideways(target: Element | null): boolean {
  for (let element = target; element && element !== document.body; element = element.parentElement) {
    if (element.scrollWidth > element.clientWidth + 1) {
      const overflow = window.getComputedStyle(element).overflowX;
      if ((overflow === 'auto' || overflow === 'scroll') && element.scrollLeft > 0) return true;
    }
  }
  return false;
}

function ensureIndicator(): HTMLDivElement | null {
  if (indicator?.isConnected) return indicator;
  const host = document.querySelector('.app');
  if (!host) return null;
  indicator = document.createElement('div');
  indicator.className = 'edge-swipe';
  indicator.setAttribute('aria-hidden', 'true');
  const SVG = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG, 'svg');
  for (const [name, value] of Object.entries({ width: '20', height: '20', viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) {
    svg.setAttribute(name, value);
  }
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', 'm15 18-6-6 6-6');
  svg.append(path);
  indicator.append(svg);
  host.append(indicator);
  return indicator;
}

function hideIndicator(): void {
  if (!indicator) return;
  indicator.style.transition = 'opacity 140ms ease-out, transform 140ms ease-out';
  indicator.style.opacity = '0';
  indicator.style.transform = `translate3d(0, ${indicator.dataset.y ?? 0}px, 0)`;
  delete indicator.dataset.armed;
}

function onTouchStart(event: TouchEvent): void {
  const touch = event.touches[0];
  if (!touch) return;
  if (touch.clientX <= 32) lastEdgeTouchAt = Date.now();
  swipe = null;
  if (event.touches.length !== 1 || touch.clientX > EDGE_WIDTH) return;
  if (isAnyOverlayOpen() || !topRegistration()) return;
  const target = event.target instanceof Element ? event.target : null;
  // Not over a focused field, nor over anything that itself scrolls sideways and has somewhere to go.
  if (target && isTypingTarget(target) && target === document.activeElement) return;
  if (scrollsSideways(target)) return;
  swipe = { id: touch.identifier, startX: touch.clientX, startY: touch.clientY, key: currentLocationKey(), armed: false };
}

function onTouchMove(event: TouchEvent): void {
  if (!swipe) return;
  const touch = [...event.touches].find((item) => item.identifier === swipe!.id);
  if (!touch || event.touches.length !== 1) {
    swipe = null;
    hideIndicator();
    return;
  }
  const dx = touch.clientX - swipe.startX;
  const dy = touch.clientY - swipe.startY;
  if (Math.abs(dy) > MAX_DRIFT || dx < -8 || (window.getSelection()?.toString() ?? '') !== '') {
    swipe = null;
    hideIndicator();
    return;
  }
  swipe.armed = dx >= TRIGGER_DISTANCE;
  const mark = ensureIndicator();
  if (!mark) return;
  const frame = mark.parentElement!.getBoundingClientRect();
  const y = touch.clientY - frame.top;
  mark.dataset.y = String(y);
  mark.style.transition = 'none';
  mark.style.opacity = String(Math.min(1, Math.max(0, dx / 40)));
  mark.style.transform = `translate3d(${Math.min(64, Math.max(0, dx * 0.7))}px, ${y}px, 0)`;
  if (swipe.armed) mark.dataset.armed = '';
  else delete mark.dataset.armed;
}

function onTouchEnd(event: TouchEvent): void {
  const state = swipe;
  swipe = null;
  hideIndicator();
  if (!state || event.type === 'touchcancel' || !state.armed) return;
  // The browser's own back gesture may have fired as well; if the page already changed, do not go back twice.
  if (state.key !== currentLocationKey() || isAnyOverlayOpen()) return;
  performBack();
}

let installed = false;

/** Install the keyboard chords and the edge swipe. Called once by the app shell. */
export function installBackGestures(getLocationKey: () => string): void {
  currentLocationKey = getLocationKey;
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', onKeyDown);
  document.addEventListener('touchstart', onTouchStart, { passive: true });
  document.addEventListener('touchmove', onTouchMove, { passive: true });
  document.addEventListener('touchend', onTouchEnd, { passive: true });
  document.addEventListener('touchcancel', onTouchEnd, { passive: true });
}

/** For tests. */
export function __resetBackForTests(): void {
  registrations.clear();
  expectedPopUntil = 0;
  lastEdgeTouchAt = 0;
}
