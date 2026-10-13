import './schema-config';
import { HEADER_CSRF, apiErrorSchema } from '@agent-studio/protocol';
import type { ZodType } from 'zod';

/**
 * The HTTP client every feature uses to talk to the server.
 *
 * It exists so that four rules are followed everywhere without anyone having
 * to remember them:
 *
 *  - requests are same-origin and carry the session cookie, nothing else;
 *  - every state-changing request carries the anti-forgery header;
 *  - `401` means the session is over: the app forgets it and shows sign-in
 *    (a `5xx` or a network failure never does);
 *  - `403 reauth_required` asks the user for their password once and then
 *    repeats the request.
 *
 * `createHttpClient` takes its collaborators as arguments so it can be tested
 * without a browser; the app's instance is `api` in `./api.ts`.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Why a request failed. `code` is the server's stable code, or one of the client-side ones below. */
export class ApiError extends Error {
  /** HTTP status, or 0 when no response arrived. */
  readonly status: number;
  /**
   * The server's machine-readable code (`not_found`, `rate_limited`, …) or a
   * client-side one: `network_error`, `timeout`, `aborted`, `invalid_response`,
   * `reauth_cancelled`.
   */
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** The server could not be reached, or it failed: worth offering "Retry". The thing asked for may be fine. */
  get unreachable(): boolean {
    return this.status === 0 || this.status >= 500 || this.status === 429 || this.code === 'timeout';
  }

  /** The thing asked for does not exist (or is not visible to this user): retrying will not help. */
  get gone(): boolean {
    return this.status === 404 || this.status === 410;
  }

  /** Seconds the server asked us to wait, when it said so. */
  get retryAfterSeconds(): number | null {
    const value = (this.details as { retryAfterSeconds?: unknown } | null | undefined)?.retryAfterSeconds;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  }

  /** Field-level problems from a `400 invalid_request`. */
  get fieldIssues(): { path: string; message: string }[] {
    if (!Array.isArray(this.details)) return [];
    return this.details.filter(
      (item): item is { path: string; message: string } =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { path?: unknown }).path === 'string' &&
        typeof (item as { message?: unknown }).message === 'string',
    );
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions<T = unknown> {
  /** JSON body. Omit for no body. */
  body?: unknown;
  /** Query-string parameters; null and undefined are left out. */
  query?: Record<string, QueryValue>;
  /** Validates (and types) the response. Use the schema from `@agent-studio/protocol` whenever one exists. */
  schema?: ZodType<T>;
  signal?: AbortSignal;
  /** Milliseconds before the request is abandoned. Default 20 000. */
  timeoutMs?: number;
  /**
   * Set on the few calls where `401` is an answer rather than "your session is
   * over" (checking a password, for example).
   */
  expectUnauthorized?: boolean;
  /** Do not open the step-up dialog for `reauth_required`; fail with that error instead. */
  noReauth?: boolean;
  /** Lets the request outlive the page (a last save while it is being hidden). */
  keepalive?: boolean;
}

export interface HttpClientDeps {
  fetch: typeof fetch;
  /** The anti-forgery token of the current session, or null when signed out. */
  getCsrfToken: () => string | null;
  /** The server said the session is over. */
  onUnauthorized: () => void;
  /** Ask the user to confirm their identity. Resolves true when they did. */
  requestReauth: () => Promise<boolean>;
  /**
   * The anti-forgery token was refused. Re-read the session (another tab may
   * have signed in again) and resolve true when a new token is available.
   */
  refreshSession?: () => Promise<boolean>;
  /** Prefix for every path; "" in the browser. */
  baseUrl?: string;
  defaultTimeoutMs?: number;
}

export interface HttpClient {
  request<T = unknown>(method: HttpMethod, path: string, options?: RequestOptions<T>): Promise<T>;
  get<T = unknown>(path: string, options?: RequestOptions<T>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown, options?: RequestOptions<T>): Promise<T>;
  put<T = unknown>(path: string, body?: unknown, options?: RequestOptions<T>): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown, options?: RequestOptions<T>): Promise<T>;
  delete<T = unknown>(path: string, options?: RequestOptions<T>): Promise<T>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

function buildUrl(baseUrl: string, path: string, query: RequestOptions['query']): string {
  if (!path.startsWith('/') || path.startsWith('//')) {
    // A full URL here would send the session's anti-forgery token to another origin.
    throw new ApiError(0, 'invalid_request', `API paths must be same-origin and start with "/": ${path}`);
  }
  if (!query) return baseUrl + path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return baseUrl + path + (text ? (path.includes('?') ? '&' : '?') + text : '');
}

async function readError(response: Response): Promise<ApiError> {
  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    /* not JSON: a proxy's error page, most likely */
  }
  const body = apiErrorSchema.safeParse(parsed);
  if (body.success) {
    return new ApiError(response.status, body.data.error.code, body.data.error.message, body.data.error.details);
  }
  const code =
    response.status === 401
      ? 'unauthorized'
      : response.status === 403
        ? 'forbidden'
        : response.status === 404
          ? 'not_found'
          : response.status === 429
            ? 'rate_limited'
            : response.status >= 500
              ? 'server_error'
              : 'request_failed';
  return new ApiError(response.status, code, `The server answered ${response.status}.`);
}

export function createHttpClient(deps: HttpClientDeps): HttpClient {
  const baseUrl = deps.baseUrl ?? '';
  const defaultTimeout = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function send<T>(method: HttpMethod, path: string, options: RequestOptions<T>): Promise<T> {
    const url = buildUrl(baseUrl, path, options.query);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') {
      const token = deps.getCsrfToken();
      if (token) headers[HEADER_CSRF] = token;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, options.timeoutMs ?? defaultTimeout);
    const onOuterAbort = () => controller.abort();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    let response: Response;
    try {
      response = await deps.fetch(url, {
        method,
        headers,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.keepalive ? { keepalive: true } : {}),
      });
    } catch (error) {
      if (timedOut) throw new ApiError(0, 'timeout', 'The server took too long to answer.');
      if (options.signal?.aborted) throw new ApiError(0, 'aborted', 'The request was cancelled.');
      throw new ApiError(0, 'network_error', error instanceof Error ? error.message : 'The server could not be reached.');
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onOuterAbort);
    }

    if (!response.ok) throw await readError(response);
    if (response.status === 204 || response.status === 205) return undefined as T;

    let data: unknown;
    try {
      const text = await response.text();
      data = text === '' ? undefined : JSON.parse(text);
    } catch {
      throw new ApiError(response.status, 'invalid_response', 'The server sent something that is not JSON.');
    }
    if (!options.schema) return data as T;
    const checked = options.schema.safeParse(data);
    if (!checked.success) {
      throw new ApiError(response.status, 'invalid_response', 'The server sent an answer this app does not understand.', checked.error.issues);
    }
    return checked.data;
  }

  async function request<T = unknown>(method: HttpMethod, path: string, options: RequestOptions<T> = {}): Promise<T> {
    try {
      return await send(method, path, options);
    } catch (error) {
      if (!isApiError(error)) throw error;

      if (error.status === 403 && error.code === 'reauth_required' && !options.noReauth) {
        const confirmed = await deps.requestReauth();
        if (!confirmed) throw new ApiError(403, 'reauth_cancelled', 'This needs your password to continue.');
        // Once only: if the server still refuses, the caller hears about it.
        return await send(method, path, options);
      }

      if (error.status === 403 && error.code === 'csrf_failed' && deps.refreshSession) {
        if (await deps.refreshSession()) return await send(method, path, options);
        throw error;
      }

      if (error.status === 401 && !options.expectUnauthorized && error.code !== 'invalid_credentials') {
        deps.onUnauthorized();
      }
      throw error;
    }
  }

  return {
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, ...(body === undefined ? {} : { body }) }),
    put: (path, body, options) => request('PUT', path, { ...options, ...(body === undefined ? {} : { body }) }),
    patch: (path, body, options) => request('PATCH', path, { ...options, ...(body === undefined ? {} : { body }) }),
    delete: (path, options) => request('DELETE', path, options),
  };
}
