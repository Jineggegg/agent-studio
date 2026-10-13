import { describe, expect, it } from 'vitest';
import { resolveRedirect, safeInternalPath } from './guard';

const base = { needsSetup: false, authenticated: false, current: '/', intended: null };

describe('who may be where', () => {
  it('sends everyone to setup until the first account exists', () => {
    expect(resolveRedirect({ ...base, zone: 'app', needsSetup: true })).toEqual({ to: '/setup' });
    expect(resolveRedirect({ ...base, zone: 'login', needsSetup: true })).toEqual({ to: '/setup' });
    expect(resolveRedirect({ ...base, zone: 'setup', needsSetup: true })).toBeNull();
  });

  it('never shows setup again afterwards', () => {
    expect(resolveRedirect({ ...base, zone: 'setup' })).toEqual({ to: '/login' });
    expect(resolveRedirect({ ...base, zone: 'setup', authenticated: true })).toEqual({ to: '/' });
  });

  it('sends a signed-out visitor to sign-in, remembering where they were headed', () => {
    expect(resolveRedirect({ ...base, zone: 'app', current: '/settings/account?tab=1#top' })).toEqual({ to: '/login', from: '/settings/account?tab=1#top' });
    expect(resolveRedirect({ ...base, zone: 'app', current: '/' })).toEqual({ to: '/login' });
    expect(resolveRedirect({ ...base, zone: 'login' })).toBeNull();
  });

  it('returns a signed-in visitor from sign-in to where they were headed', () => {
    expect(resolveRedirect({ ...base, zone: 'login', authenticated: true, intended: '/projects/abc' })).toEqual({ to: '/projects/abc' });
    expect(resolveRedirect({ ...base, zone: 'login', authenticated: true })).toEqual({ to: '/' });
    expect(resolveRedirect({ ...base, zone: 'app', authenticated: true })).toBeNull();
  });

  it('only ever follows paths of this app after sign-in', () => {
    for (const hostile of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/login', '/setup', '']) {
      expect(resolveRedirect({ ...base, zone: 'login', authenticated: true, intended: hostile }), hostile).toEqual({ to: '/' });
    }
    expect(safeInternalPath(42)).toBeNull();
    expect(safeInternalPath('/inbox')).toBe('/inbox');
  });

  it('leaves open routes alone whatever the session says', () => {
    expect(resolveRedirect({ ...base, zone: 'open', needsSetup: true })).toBeNull();
    expect(resolveRedirect({ ...base, zone: 'open' })).toBeNull();
  });
});
