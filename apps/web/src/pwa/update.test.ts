import { describe, expect, it } from 'vitest';
import { jsonResponse } from '@/test/render';
import { mayReloadSilently, probeVersion } from './update';

const answering = (response: Response | Error) => (async () => {
  if (response instanceof Error) throw response;
  return response;
}) as unknown as typeof fetch;

describe('noticing a newer build', () => {
  it('compares the served build id with its own', async () => {
    expect(await probeVersion(answering(jsonResponse({ buildId: 'b1', version: '2.0.0' })), 'b1')).toEqual({ state: 'current' });
    expect(await probeVersion(answering(jsonResponse({ buildId: 'b2', version: '2.0.0' })), 'b1')).toEqual({ state: 'newer', buildId: 'b2' });
  });

  it('asks without credentials and without the cache', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return jsonResponse({ buildId: 'b1' });
    }) as typeof fetch;
    await probeVersion(fetchImpl, 'b1');
    expect(seen).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error' });
  });

  it('treats anything it cannot understand as "cannot tell"', async () => {
    const unknown = { state: 'unknown' };
    expect(await probeVersion(answering(new TypeError('Failed to fetch')), 'b1')).toEqual(unknown); // offline
    expect(await probeVersion(answering(new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } })), 'b1')).toEqual(unknown); // a proxy's sign-in page
    expect(await probeVersion(answering(jsonResponse({ error: { code: 'internal_error', message: 'x' } }, 500)), 'b1')).toEqual(unknown);
    expect(await probeVersion(answering(jsonResponse({ version: '2.0.0' })), 'b1')).toEqual(unknown); // no build id
    expect(await probeVersion(answering(jsonResponse({ buildId: '' })), 'b1')).toEqual(unknown);
    expect(await probeVersion(answering(new Response('x'.repeat(5_000))), 'b1')).toEqual(unknown); // an over-large document
  });
});

describe('reloading without asking', () => {
  const safe = { sinceReturn: 2_000, touchedSinceReturn: false, overlayOpen: false, fieldHoldsText: false, unsavedWork: false, alreadyReloadedForThis: false };

  it('happens only when nothing can be lost', () => {
    expect(mayReloadSilently(safe)).toBe(true);
  });

  it.each([
    ['the page came back more than ten seconds ago', { sinceReturn: 10_001 }],
    ['the user has touched the page since', { touchedSinceReturn: true }],
    ['a sheet or dialog is open', { overlayOpen: true }],
    ['a focused field holds text', { fieldHoldsText: true }],
    ['a feature has declared unsaved work', { unsavedWork: true }],
    ['a reload for this very build already happened', { alreadyReloadedForThis: true }],
  ])('does not happen when %s', (_name, change) => {
    expect(mayReloadSilently({ ...safe, ...change })).toBe(false);
  });
});
