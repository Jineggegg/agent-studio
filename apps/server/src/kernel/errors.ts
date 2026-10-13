/**
 * Errors that are safe to show to a client. Anything else that escapes a
 * request handler is reported as a generic 500 and logged server-side.
 */
export class StudioError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'StudioError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message: string, details?: unknown, code = 'bad_request') =>
  new StudioError(400, code, message, details);
export const unauthorized = (message = 'Sign in to continue.', code = 'unauthorized') =>
  new StudioError(401, code, message);
export const forbidden = (message = 'You do not have access to this.', code = 'forbidden') =>
  new StudioError(403, code, message);
export const notFound = (message = 'Not found.', code = 'not_found') =>
  new StudioError(404, code, message);
export const conflict = (message: string, code = 'conflict', details?: unknown) =>
  new StudioError(409, code, message, details);
export const payloadTooLarge = (message = 'That is too large.', code = 'too_large') =>
  new StudioError(413, code, message);
export const unprocessable = (message: string, code = 'unprocessable', details?: unknown) =>
  new StudioError(422, code, message, details);
export const rateLimited = (retryAfterSeconds: number, message = 'Too many attempts. Try again later.') =>
  new StudioError(429, 'rate_limited', message, { retryAfterSeconds });
export const unavailable = (message: string, code = 'unavailable', details?: unknown) =>
  new StudioError(503, code, message, details);

export function isStudioError(value: unknown): value is StudioError {
  return value instanceof StudioError;
}

/** A short, loggable description of an unknown thrown value. */
export function describeError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
