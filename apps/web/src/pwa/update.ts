import { useEffect } from 'react';
import { z } from 'zod';
import { currentTranslator } from '@/i18n';
import { toast } from '@/ui/Toast';
import { isAnyOverlayOpen } from '@/ui/overlay';

/**
 * Noticing that a newer build has been deployed while this page stayed open.
 *
 * The build writes its id into the bundle and into /version.json. Comparing
 * the two tells whether the server now serves something newer. When it does:
 *
 *  - the page reloads by itself only when that cannot lose anything — it has
 *    just come back from the background, has not been touched since, shows no
 *    sheet or dialog, holds no text in a focused field and no feature has
 *    declared unsaved work;
 *  - otherwise a toast offers "Refresh" and stays until used.
 *
 * An answer that cannot be understood (offline, an error page, a sign-in page
 * from a proxy, a timeout) means "cannot tell" and triggers nothing.
 */

/** This build's id; "dev" when running from the development server. */
export const BUILD_ID: string = __BUILD_ID__;
export const BUILD_TIME: number = __BUILD_TIME__;

const versionSchema = z.object({ buildId: z.string().min(1).max(100) });

const CHECK_TIMEOUT_MS = 10_000;
const SHARE_WINDOW_MS = 10_000;
const INTERVAL_MS = 5 * 60_000;
const AUTO_RELOAD_WINDOW_MS = 10_000;
const RELOADED_FOR_KEY = 'studio.reloaded-for';
const UPDATE_TOAST_ID = 'app-update';

export type UpdateProbe = { state: 'current' } | { state: 'newer'; buildId: string } | { state: 'unknown' };

/** Ask the server which build it serves. Never throws. */
export async function probeVersion(fetchImpl: typeof fetch = fetch, ownBuildId: string = BUILD_ID): Promise<UpdateProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${import.meta.env.BASE_URL}version.json`, {
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return { state: 'unknown' };
    const text = await response.text();
    if (text.length > 2_000) return { state: 'unknown' };
    const parsed = versionSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return { state: 'unknown' };
    return parsed.data.buildId === ownBuildId ? { state: 'current' } : { state: 'newer', buildId: parsed.data.buildId };
  } catch {
    return { state: 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}

// ---- "can a reload lose anything?" ---------------------------------------------

let unsavedCount = 0;

/**
 * Declare unsaved work while `dirty` is true (a half-written message, an
 * edited file). The page never reloads itself while any is declared.
 */
export function useUnsavedWork(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    unsavedCount += 1;
    return () => {
      unsavedCount -= 1;
    };
  }, [dirty]);
}

function focusedFieldHoldsText(): boolean {
  const element = document.activeElement;
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value !== '';
  return element instanceof HTMLElement && element.isContentEditable && (element.textContent ?? '') !== '';
}

export interface ReloadSafetyInput {
  /** ms since the page last came back from the background. */
  sinceReturn: number;
  touchedSinceReturn: boolean;
  overlayOpen: boolean;
  fieldHoldsText: boolean;
  unsavedWork: boolean;
  /** A reload for this very build has already been tried. */
  alreadyReloadedForThis: boolean;
}

/** The rule for reloading without asking, as one readable predicate. */
export function mayReloadSilently(input: ReloadSafetyInput): boolean {
  return (
    input.sinceReturn <= AUTO_RELOAD_WINDOW_MS &&
    !input.touchedSinceReturn &&
    !input.overlayOpen &&
    !input.fieldHoldsText &&
    !input.unsavedWork &&
    !input.alreadyReloadedForThis
  );
}

// ---- checking ------------------------------------------------------------------

let returnedAt = Date.now();
let touchedSinceReturn = true; // a freshly loaded page is by definition current; nothing to do until it has been away
let lastCheckAt = 0;
let inFlight: Promise<UpdateProbe> | null = null;
let lastProbe: UpdateProbe = { state: 'current' };

function reloadedFor(): string | null {
  try {
    return window.sessionStorage.getItem(RELOADED_FOR_KEY);
  } catch {
    return null;
  }
}

function reloadInto(buildId: string): void {
  try {
    window.sessionStorage.setItem(RELOADED_FOR_KEY, buildId);
  } catch {
    /* ignore */
  }
  window.location.reload();
}

function offerRefresh(buildId: string): void {
  const t = currentTranslator();
  toast.show({
    id: UPDATE_TOAST_ID,
    kind: 'info',
    title: t('update.title'),
    detail: t('update.detail'),
    duration: 'persistent',
    action: { label: t('update.refresh'), onSelect: () => reloadInto(buildId) },
  });
}

async function probeShared(): Promise<UpdateProbe> {
  if (inFlight) return inFlight;
  if (Date.now() - lastCheckAt < SHARE_WINDOW_MS) return lastProbe;
  lastCheckAt = Date.now();
  inFlight = probeVersion().then((probe) => {
    lastProbe = probe;
    inFlight = null;
    return probe;
  });
  return inFlight;
}

/**
 * Check now. With `reloadIfNewer` (the home screen's refresh action) a newer
 * build is loaded immediately; the promise then resolves true and the page is
 * already on its way out. Otherwise a newer build is offered by toast.
 */
export async function checkForUpdate(options: { reloadIfNewer?: boolean } = {}): Promise<boolean> {
  if (BUILD_ID === 'dev') return false;
  lastCheckAt = 0;
  const probe = await probeShared();
  if (probe.state !== 'newer') return false;
  if (options.reloadIfNewer) {
    reloadInto(probe.buildId);
    return true;
  }
  offerRefresh(probe.buildId);
  return false;
}

async function automaticCheck(retryOnce: boolean): Promise<void> {
  const probe = await probeShared();
  if (probe.state === 'unknown') {
    // A phone often has no network for the first moment after waking.
    if (retryOnce) window.setTimeout(() => void automaticCheck(false), 2_000);
    return;
  }
  if (probe.state !== 'newer') return;
  const safe = mayReloadSilently({
    sinceReturn: Date.now() - returnedAt,
    touchedSinceReturn,
    overlayOpen: isAnyOverlayOpen(),
    fieldHoldsText: focusedFieldHoldsText(),
    unsavedWork: unsavedCount > 0,
    alreadyReloadedForThis: reloadedFor() === probe.buildId,
  });
  if (safe && document.visibilityState === 'visible') reloadInto(probe.buildId);
  else offerRefresh(probe.buildId);
}

let started = false;

/** Begin watching for newer builds. Called once at start-up; does nothing in development. */
export function startUpdateChecks(): void {
  if (started || BUILD_ID === 'dev') return;
  started = true;

  const onReturn = () => {
    returnedAt = Date.now();
    touchedSinceReturn = false;
    void automaticCheck(true);
  };
  const markTouched = () => {
    touchedSinceReturn = true;
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onReturn();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) onReturn();
  });
  window.addEventListener('online', () => void automaticCheck(false));
  window.addEventListener('pointerdown', markTouched, { capture: true, passive: true });
  window.addEventListener('keydown', markTouched, { capture: true, passive: true });
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void automaticCheck(false);
  }, INTERVAL_MS);
}
