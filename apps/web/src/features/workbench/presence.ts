import { useEffect } from 'react';
import { usePageVisible } from '@/platform/media';
import { useScreenActive } from '@/shell/ScreenStack';
import { workbenchApi } from './api';

/**
 * Tells the server which sessions are visibly on screen in this tab, so that
 * a result that arrives while the user is looking at it is not reported as
 * "finished, not yet seen" and raises no notification.
 *
 * A report is believed for 90 s, so it is repeated while the session stays on
 * screen and withdrawn (an empty report) the moment the page is hidden or the
 * session is left. Each report replaces the tab's previous one.
 */
const HEARTBEAT_MS = 40_000;
const CLIENT_KEY = 'studio.workbench.client';

let clientId: string | null = null;

/** Identifies this tab to the server. Kept for the life of the tab (a reload is the same tab). */
export function presenceClientId(): string {
  if (clientId) return clientId;
  try {
    const stored = window.sessionStorage.getItem(CLIENT_KEY);
    if (stored && /^[A-Za-z0-9_-]{8,64}$/.test(stored)) return (clientId = stored);
  } catch {
    /* fall through */
  }
  const bytes = new Uint8Array(12);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  clientId = `tab-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  try {
    window.sessionStorage.setItem(CLIENT_KEY, clientId);
  } catch {
    /* the id lasts for this page only */
  }
  return clientId;
}

let reported: string[] = [];

function report(visible: string[], keepalive = false): void {
  reported = visible;
  void workbenchApi.presence({ clientId: presenceClientId(), visible }, keepalive).catch(() => {
    /* a missed report costs one "unseen" mark at worst; the next one corrects it */
  });
}

/**
 * Reports `sessionId` as on screen for as long as the component is mounted,
 * its screen is the one on show and the page is visible.
 */
export function usePresence(sessionId: string | null): void {
  const visible = usePageVisible();
  const active = useScreenActive();
  const onScreen = sessionId !== null && visible && active;

  useEffect(() => {
    if (!onScreen || sessionId === null) return;
    report([sessionId]);
    const timer = window.setInterval(() => report([sessionId]), HEARTBEAT_MS);
    return () => {
      window.clearInterval(timer);
      // Hidden pages are being suspended: let the request outlive them.
      if (reported.length > 0) report([], document.visibilityState === 'hidden');
    };
  }, [onScreen, sessionId]);
}
