import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetPreferencesForTests, beginPreferences, getPreference, setPreference, usePreferences } from '@/data/preferences';
import { NEW_ACCOUNT_MS, WELCOME_KEY, dismissProgress, finishProgress, freshProgress, markStep, nextStep, parseProgress, shouldOffer, stepsDone, stepsFor } from './progress';

describe('the welcome guide’s progress', () => {
  it('gives the owner every step and a member the lighter guide', () => {
    expect(stepsFor('owner')).toEqual(['identity', 'agents', 'project', 'notifications']);
    expect(stepsFor('member')).toEqual(['identity', 'notifications']);
  });

  it('continues at the first step neither done nor skipped', () => {
    let progress = freshProgress(1);
    expect(nextStep(progress, 'owner')).toBe('identity');
    progress = markStep(progress, 'identity', 'done', 2);
    progress = markStep(progress, 'agents', 'skipped', 3);
    expect(nextStep(progress, 'owner')).toBe('project');
    expect(nextStep(progress, 'member')).toBe('notifications');
    expect(stepsDone(progress, 'owner')).toEqual({ done: 2, total: 4 });
    progress = markStep(markStep(progress, 'project', 'done', 4), 'notifications', 'skipped', 5);
    expect(nextStep(progress, 'owner')).toBeNull();
  });

  it('reads back only what it wrote, and anything else as nothing stored', () => {
    const progress = markStep(freshProgress(1), 'identity', 'done', 2);
    expect(parseProgress(JSON.parse(JSON.stringify(progress)))).toEqual(progress);
    expect(parseProgress(null)).toBeNull();
    expect(parseProgress({ v: 2, state: 'open' })).toBeNull();
    expect(parseProgress({ v: 1, state: 'later' })).toBeNull();
    expect(parseProgress({ v: 1, state: 'open', steps: { identity: 'maybe', agents: 'done', other: 'done' } })).toEqual({ v: 1, state: 'open', steps: { agents: 'done' }, updatedAt: 0 });
  });

  it('offers the guide to a new account until it is finished or put away — and never before the preferences are read', () => {
    const now = 10 * NEW_ACCOUNT_MS;
    const fresh = { loaded: true, createdAt: now - 1000, now };
    expect(shouldOffer(null, fresh)).toBe(true);
    expect(shouldOffer(null, { ...fresh, loaded: false })).toBe(false);
    expect(shouldOffer(null, { ...fresh, createdAt: now - NEW_ACCOUNT_MS - 1 })).toBe(false);
    expect(shouldOffer(markStep(null, 'identity', 'done', now), { ...fresh, createdAt: 0 })).toBe(true);
    expect(shouldOffer(finishProgress(null, now), fresh)).toBe(false);
    expect(shouldOffer(dismissProgress(markStep(null, 'identity', 'done', now), now), fresh)).toBe(false);
  });

  it('keeps a step’s outcome after the guide was put away', () => {
    const dismissed = dismissProgress(null, 1);
    expect(markStep(dismissed, 'identity', 'done', 2).state).toBe('dismissed');
  });
});

describe('progress kept as an account preference', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ values: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))));
    __resetPreferencesForTests();
    beginPreferences('user-1');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    __resetPreferencesForTests();
  });

  it('survives a reload on this device and is what the next visit reads', () => {
    setPreference(WELCOME_KEY, markStep(null, 'identity', 'done', 5));
    // A new page on the same device draws from its copy of the preferences straight away.
    usePreferences.setState({ values: {}, loaded: false });
    beginPreferences('user-1');
    expect(parseProgress(getPreference(WELCOME_KEY))?.steps).toEqual({ identity: 'done' });
    expect(nextStep(parseProgress(getPreference(WELCOME_KEY)), 'owner')).toBe('agents');
  });

  it('is not shared with the next person signing in on the device', () => {
    setPreference(WELCOME_KEY, finishProgress(null, 5));
    beginPreferences('user-2');
    expect(getPreference(WELCOME_KEY)).toBeUndefined();
  });
});
