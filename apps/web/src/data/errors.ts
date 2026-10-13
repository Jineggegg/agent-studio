import { type Translator, hasMessage } from '@/i18n';
import { isApiError } from './http';

/**
 * Turns anything thrown by the data layer into a sentence for the user, in
 * their language. Known server codes have translations (`errors.<code>` in
 * the dictionaries); unknown ones fall back to the server's own message,
 * which is always safe to show.
 */
export function describeError(error: unknown, t: Translator): string {
  if (isApiError(error)) {
    if (error.code === 'rate_limited') {
      const seconds = error.retryAfterSeconds;
      return seconds ? t('errors.rate_limited_for', { duration: t.duration(seconds) }) : t('errors.rate_limited');
    }
    const key = `errors.${error.code}`;
    if (hasMessage(key)) return t(key);
    if (error.status >= 500) return t('errors.server_error');
    if (error.message) return error.message;
  }
  return t('errors.unknown');
}

export type ErrorKind =
  /** It does not exist (any more), or is not visible to this user. Retrying will not help. */
  | 'gone'
  /** The server could not be reached or failed. The thing itself may be fine: offer Retry. */
  | 'unreachable'
  /** The user may not do or see this. */
  | 'forbidden'
  /** Anything else. */
  | 'failed';

export function errorKind(error: unknown): ErrorKind {
  if (!isApiError(error)) return 'failed';
  if (error.gone) return 'gone';
  if (error.unreachable) return 'unreachable';
  if (error.status === 403) return 'forbidden';
  return 'failed';
}
