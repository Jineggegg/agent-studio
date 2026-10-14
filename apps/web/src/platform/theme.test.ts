import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyThemePreference, useThemeStore } from './theme';

/** A stand-in for `document.startViewTransition`: the update runs when the test says, and a skipped one rejects. */
function fakeViewTransitions() {
  const started: { callback: () => void; skip: () => void }[] = [];
  const start = vi.fn((callback: () => void) => {
    let rejectReady: (reason: unknown) => void = () => {};
    const ready = new Promise((_resolve, reject) => {
      rejectReady = reject;
    });
    let resolveFinished: () => void = () => {};
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve;
    });
    // As in a browser: starting a transition skips the one before it, whose `ready` rejects and whose update still runs.
    const previous = started.at(-1);
    previous?.skip();
    const entry = {
      callback: () => {
        callback();
        resolveFinished();
      },
      skip: () => {
        rejectReady(new DOMException('Transition was skipped', 'AbortError'));
        entry.callback();
      },
    };
    started.push(entry);
    return { ready, finished, updateCallbackDone: Promise.resolve() };
  });
  Object.defineProperty(document, 'startViewTransition', { value: start, configurable: true, writable: true });
  return { start, started };
}

describe('changing the theme with view transitions', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);

  beforeEach(() => {
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
    applyThemePreference('light');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    delete (document as { startViewTransition?: unknown }).startViewTransition;
  });

  it('makes one transition for one change, even when the same choice is applied again before it lands', async () => {
    const { start, started } = fakeViewTransitions();
    applyThemePreference('dark', { crossFade: true });
    // The account sync re-reads the preference that was just set, while the cross-fade is still on its way.
    applyThemePreference('dark', { crossFade: true });
    expect(start).toHaveBeenCalledTimes(1);
    expect(useThemeStore.getState().theme).toBe('light');
    started[0]!.callback();
    expect(useThemeStore.getState().theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.documentElement.dataset.themeFade).toBeUndefined();
    expect(unhandled).toEqual([]);
  });

  it('lets a quick second change win, and leaves no skipped transition rejecting unheard', async () => {
    const { started } = fakeViewTransitions();
    applyThemePreference('dark', { crossFade: true });
    applyThemePreference('light', { crossFade: true });
    expect(started).toHaveLength(2);
    started[1]!.callback();
    expect(useThemeStore.getState().theme).toBe('light');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(unhandled).toEqual([]);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('a change without a cross-fade during one ends it: the newest choice is what shows', async () => {
    const { started } = fakeViewTransitions();
    applyThemePreference('dark', { crossFade: true });
    applyThemePreference('auto');
    started[0]!.callback();
    expect(useThemeStore.getState().preference).toBe('auto');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.documentElement.dataset.themeFade).toBeUndefined();
    expect(unhandled).toEqual([]);
  });
});
