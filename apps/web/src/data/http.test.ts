import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { errorResponse, jsonResponse } from '@/test/render';
import { ApiError, type HttpClientDeps, createHttpClient } from './http';

type FetchCall = { url: string; init: RequestInit };

function setup(responses: (Response | Error | ((call: FetchCall) => Response | Promise<Response>))[], overrides: Partial<HttpClientDeps> = {}) {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const deps: HttpClientDeps = {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const call = { url: String(input), init: init ?? {} };
      calls.push(call);
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected request to ${call.url}`);
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next(call) : next;
    }) as typeof fetch,
    getCsrfToken: () => 'csrf-token-1',
    onUnauthorized: vi.fn(),
    requestReauth: vi.fn(async () => true),
    ...overrides,
  };
  return { client: createHttpClient(deps), calls, deps };
}

const header = (call: FetchCall, name: string): string | undefined => (call.init.headers as Record<string, string>)[name];

describe('the HTTP client', () => {
  it('sends the anti-forgery header on every state-changing request and never on GET', async () => {
    const { client, calls } = setup([jsonResponse({}), jsonResponse({}), jsonResponse({}), jsonResponse({}), jsonResponse({})]);
    await client.get('/api/projects');
    await client.post('/api/projects', { name: 'x' });
    await client.put('/api/thing', {});
    await client.patch('/api/thing', {});
    await client.delete('/api/thing');

    expect(header(calls[0]!, 'x-studio-csrf')).toBeUndefined();
    for (const call of calls.slice(1)) expect(header(call, 'x-studio-csrf')).toBe('csrf-token-1');
  });

  it('stays same-origin: cookies only for this origin, no caching, and no full URLs', async () => {
    const { client, calls } = setup([jsonResponse({ ok: true })]);
    await client.post('/api/x', { a: 1 }, { query: { limit: 5, skip: undefined, q: 'a b' } });
    expect(calls[0]!.url).toBe('/api/x?limit=5&q=a+b');
    expect(calls[0]!.init.credentials).toBe('same-origin');
    expect(calls[0]!.init.cache).toBe('no-store');
    expect(calls[0]!.init.body).toBe('{"a":1}');
    expect(header(calls[0]!, 'content-type')).toBe('application/json');

    await expect(client.get('https://evil.example/api')).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(client.get('//evil.example/api')).rejects.toMatchObject({ code: 'invalid_request' });
    expect(calls).toHaveLength(1);
  });

  it('omits the anti-forgery header when signed out', async () => {
    const { client, calls } = setup([jsonResponse({})], { getCsrfToken: () => null });
    await client.post('/api/auth/login', { username: 'a', password: 'b' });
    expect(header(calls[0]!, 'x-studio-csrf')).toBeUndefined();
  });

  it("turns the server's error body into a typed error", async () => {
    const { client } = setup([errorResponse(409, 'project_exists', 'That folder is already a project.', { path: '/x' })]);
    const error = await client.post('/api/projects', {}).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 409, code: 'project_exists', message: 'That folder is already a project.', details: { path: '/x' } });
  });

  it('exposes the wait time and field issues the server reports', async () => {
    const { client } = setup([
      errorResponse(429, 'rate_limited', 'Too many attempts.', { retryAfterSeconds: 90 }),
      errorResponse(400, 'invalid_request', 'The request is not valid.', [{ path: 'name', message: 'Too short' }]),
    ]);
    const limited = (await client.post('/api/auth/login', {}).catch((reason: unknown) => reason)) as ApiError;
    expect(limited.retryAfterSeconds).toBe(90);
    expect(limited.unreachable).toBe(true);
    const invalid = (await client.post('/api/x', {}).catch((reason: unknown) => reason)) as ApiError;
    expect(invalid.fieldIssues).toEqual([{ path: 'name', message: 'Too short' }]);
  });

  it('copes with an error that is not the JSON envelope (a proxy page)', async () => {
    const { client } = setup([new Response('<html>Bad gateway</html>', { status: 502 })]);
    await expect(client.get('/api/x')).rejects.toMatchObject({ status: 502, code: 'server_error' });
  });

  it('reports the session as over on 401 — and only then', async () => {
    const { client, deps } = setup([errorResponse(401, 'unauthorized', 'Sign in to continue.')]);
    await expect(client.get('/api/projects')).rejects.toMatchObject({ status: 401 });
    expect(deps.onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('does not treat a wrong password as the end of the session', async () => {
    const { client, deps } = setup([errorResponse(401, 'invalid_credentials', 'Wrong.'), errorResponse(401, 'unauthorized', 'No.')]);
    await expect(client.post('/api/auth/reauth', { password: 'x' })).rejects.toMatchObject({ code: 'invalid_credentials' });
    await expect(client.get('/api/auth/state', { expectUnauthorized: true })).rejects.toMatchObject({ status: 401 });
    expect(deps.onUnauthorized).not.toHaveBeenCalled();
  });

  it('never signs the user out because the server failed or could not be reached', async () => {
    const { client, deps } = setup([errorResponse(500, 'internal_error'), errorResponse(503, 'unavailable'), new TypeError('Failed to fetch'), errorResponse(429, 'rate_limited')]);
    await expect(client.get('/api/a')).rejects.toMatchObject({ status: 500, unreachable: true });
    await expect(client.get('/api/b')).rejects.toMatchObject({ status: 503, unreachable: true });
    await expect(client.get('/api/c')).rejects.toMatchObject({ status: 0, code: 'network_error', unreachable: true });
    await expect(client.get('/api/d')).rejects.toMatchObject({ status: 429 });
    expect(deps.onUnauthorized).not.toHaveBeenCalled();
  });

  it('asks for the password on reauth_required, then repeats the request once', async () => {
    const { client, calls, deps } = setup([errorResponse(403, 'reauth_required', 'Confirm your identity.'), jsonResponse({ token: 'ast_secret' })]);
    const result = await client.post<{ token: string }>('/api/auth/tokens', { name: 'ci' });
    expect(result.token).toBe('ast_secret');
    expect(deps.requestReauth).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toBe('/api/auth/tokens');
    expect(calls[1]!.init.body).toBe('{"name":"ci"}');
  });

  it('retries only once: a second reauth_required reaches the caller', async () => {
    const { client, calls, deps } = setup([errorResponse(403, 'reauth_required'), errorResponse(403, 'reauth_required')]);
    await expect(client.delete('/api/users/1')).rejects.toMatchObject({ code: 'reauth_required' });
    expect(deps.requestReauth).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
  });

  it('gives up without retrying when the user cancels the password prompt', async () => {
    const { client, calls } = setup([errorResponse(403, 'reauth_required')], { requestReauth: async () => false });
    await expect(client.post('/api/users', {})).rejects.toMatchObject({ status: 403, code: 'reauth_cancelled' });
    expect(calls).toHaveLength(1);
  });

  it('can be told not to prompt', async () => {
    const { client, deps } = setup([errorResponse(403, 'reauth_required')]);
    await expect(client.post('/api/x', {}, { noReauth: true })).rejects.toMatchObject({ code: 'reauth_required' });
    expect(deps.requestReauth).not.toHaveBeenCalled();
  });

  it('re-reads the session once when the anti-forgery token is refused', async () => {
    let token = 'stale';
    const refreshSession = vi.fn(async () => {
      token = 'fresh';
      return true;
    });
    const { client, calls } = setup([errorResponse(403, 'csrf_failed'), jsonResponse({ ok: true })], { getCsrfToken: () => token, refreshSession });
    await client.post('/api/x', {});
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(header(calls[0]!, 'x-studio-csrf')).toBe('stale');
    expect(header(calls[1]!, 'x-studio-csrf')).toBe('fresh');
  });

  it('validates answers with the schema it is given', async () => {
    const schema = z.object({ id: z.string(), count: z.number() });
    const { client } = setup([jsonResponse({ id: 'a', count: 2 }), jsonResponse({ id: 'a', count: 'two' })]);
    await expect(client.get('/api/x', { schema })).resolves.toEqual({ id: 'a', count: 2 });
    await expect(client.get('/api/x', { schema })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('returns undefined for 204 and rejects a body that is not JSON', async () => {
    const { client } = setup([new Response(null, { status: 204 }), new Response('<html>', { status: 200 })]);
    await expect(client.delete('/api/x')).resolves.toBeUndefined();
    await expect(client.get('/api/x')).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('abandons a request that takes too long', async () => {
    vi.useFakeTimers();
    try {
      const { client } = setup([
        ({ init }) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          }),
      ]);
      const pending = client.get('/api/slow', { timeoutMs: 1_000 }).catch((reason: unknown) => reason);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(await pending).toMatchObject({ status: 0, code: 'timeout', unreachable: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('distinguishes "gone" from "unreachable"', () => {
    expect(new ApiError(404, 'not_found', '').gone).toBe(true);
    expect(new ApiError(404, 'not_found', '').unreachable).toBe(false);
    expect(new ApiError(0, 'network_error', '').unreachable).toBe(true);
    expect(new ApiError(0, 'network_error', '').gone).toBe(false);
    expect(new ApiError(403, 'forbidden', '').unreachable).toBe(false);
  });
});
