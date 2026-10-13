import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '@/test/render';
import {
  __resetPreferencesForTests,
  applyRemotePreferences,
  beginPreferences,
  flushPreferences,
  forgetPreferences,
  handlePreferencesEvent,
  loadPreferences,
  setPreference,
  setPreferences,
  usePreferences,
} from './preferences';
import { resetSessionStore, useSession } from './session';

const values = () => usePreferences.getState().values;
let server: Record<string, unknown>;
let patches: Record<string, unknown>[];
let failNext: Response | null;

beforeEach(() => {
  vi.useFakeTimers();
  __resetPreferencesForTests();
  resetSessionStore();
  useSession.setState({ status: 'ready', authenticated: true, csrfToken: 'csrf' });
  server = { 'appearance.theme': 'dark' };
  patches = [];
  failNext = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (failNext) {
        const response = failNext;
        failNext = null;
        return response;
      }
      if (init?.method === 'PATCH') {
        const patch = (JSON.parse(String(init.body)) as { values: Record<string, unknown> }).values;
        patches.push(patch);
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete server[key];
          else server[key] = value;
        }
      }
      return jsonResponse({ values: server });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('account preferences', () => {
  it('reads the server, which is the authority', async () => {
    beginPreferences('user-1');
    expect(usePreferences.getState().loaded).toBe(false);
    await loadPreferences();
    expect(values()).toEqual({ 'appearance.theme': 'dark' });
    expect(usePreferences.getState().loaded).toBe(true);
  });

  it('applies a change at once and saves it after a short pause, several changes together', async () => {
    beginPreferences('user-1');
    await loadPreferences();
    setPreference('appearance.theme', 'light');
    setPreference('home.showNames', false);
    expect(values()).toEqual({ 'appearance.theme': 'light', 'home.showNames': false }); // immediately
    expect(patches).toEqual([]);

    await vi.advanceTimersByTimeAsync(399);
    expect(patches).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(patches).toEqual([{ 'appearance.theme': 'light', 'home.showNames': false }]);
  });

  it('removes a key when it is set to null', async () => {
    beginPreferences('user-1');
    await loadPreferences();
    setPreferences({ 'appearance.theme': null });
    expect(values()).toEqual({});
    await flushPreferences();
    expect(patches).toEqual([{ 'appearance.theme': null }]);
    expect(server).toEqual({});
  });

  it('keeps a copy on the device for the next start, per user', async () => {
    beginPreferences('user-1');
    await loadPreferences();
    setPreference('home.layout', { order: ['a', 'b'] });

    __resetPreferencesForTests(); // a new page load
    beginPreferences('user-1');
    expect(values()).toEqual({ 'appearance.theme': 'dark', 'home.layout': { order: ['a', 'b'] } }); // before any request

    __resetPreferencesForTests();
    beginPreferences('someone-else');
    expect(values()).toEqual({}); // never another account's copy
  });

  it('erases the device copy on sign-out, so the next person does not inherit it', async () => {
    beginPreferences('user-1');
    await loadPreferences();
    expect(window.localStorage.getItem('studio.preferences')).toContain('dark');
    forgetPreferences();
    expect(values()).toEqual({});
    expect(window.localStorage.getItem('studio.preferences')).toBeNull();
  });

  it('merges a change from another device key by key', async () => {
    beginPreferences('user-1');
    await loadPreferences();
    setPreference('home.showNames', true);
    await flushPreferences();

    handlePreferencesEvent({ type: 'preferences.changed', data: { values: { 'appearance.theme': 'light', 'usage.display': 'used' } } });
    expect(values()).toEqual({ 'appearance.theme': 'light', 'home.showNames': true, 'usage.display': 'used' });

    applyRemotePreferences({ 'usage.display': null });
    expect(values()).toEqual({ 'appearance.theme': 'light', 'home.showNames': true });

    handlePreferencesEvent({ type: 'something.else', data: { values: { 'appearance.theme': 'dark' } } });
    handlePreferencesEvent({ type: 'preferences.changed', data: 'garbage' });
    expect(values()['appearance.theme']).toBe('light');
  });

  it("lets this page's own unsaved change win over an incoming value for the same key", async () => {
    beginPreferences('user-1');
    await loadPreferences();
    setPreference('appearance.theme', 'light'); // not saved yet
    applyRemotePreferences({ 'appearance.theme': 'dark', 'home.showNames': false });
    expect(values()).toEqual({ 'appearance.theme': 'light', 'home.showNames': false });

    // …and over a re-read of the server that happens before the save
    await loadPreferences();
    expect(values()['appearance.theme']).toBe('light');

    await flushPreferences();
    expect(server['appearance.theme']).toBe('light');
    // once saved, incoming values apply again
    applyRemotePreferences({ 'appearance.theme': 'dark' });
    expect(values()['appearance.theme']).toBe('dark');
  });

  it('keeps an unsaved change and retries when the server cannot be reached', async () => {
    beginPreferences('user-1');
    await loadPreferences();
    failNext = jsonResponse({ error: { code: 'internal_error', message: 'x' } }, 500);
    setPreference('appearance.theme', 'light');
    await flushPreferences();
    expect(usePreferences.getState().saveFailed).toBe(true);
    expect(values()['appearance.theme']).toBe('light');
    expect(server['appearance.theme']).toBe('dark');

    await vi.advanceTimersByTimeAsync(10_100);
    expect(server['appearance.theme']).toBe('light');
    expect(usePreferences.getState().saveFailed).toBe(false);
  });

  it('gives up on a change the server will never accept and shows what the server has', async () => {
    beginPreferences('user-1');
    await loadPreferences();
    failNext = jsonResponse({ error: { code: 'too_large', message: 'Too large.' } }, 413);
    setPreference('home.layout', 'x'.repeat(10));
    await flushPreferences();
    await vi.advanceTimersByTimeAsync(0);
    expect(values()).toEqual({ 'appearance.theme': 'dark' });
  });
});
