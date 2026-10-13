import { describeError } from '@/data/errors';
import { isApiError } from '@/data/http';
import type { Translator } from '@/i18n';

/** "Try again at 14:32 (in about 2 minutes)" pieces for a throttled attempt. */
export function waitDescription(seconds: number, t: Translator): { at: string; duration: string } {
  return { at: t.date(Date.now() + seconds * 1000, 'time'), duration: t.duration(seconds) };
}

/**
 * What to say when a password was refused. Wrong credentials always get the
 * same sentence — whether the account exists, is disabled or the password is
 * wrong is nobody's business — and a throttled attempt says when to come back.
 */
export function passwordFailure(error: unknown, t: Translator, wrong: string): { text: string; retryAt: number | null } {
  if (isApiError(error)) {
    if (error.code === 'invalid_credentials') return { text: wrong, retryAt: null };
    if (error.code === 'rate_limited') {
      const seconds = error.retryAfterSeconds;
      if (seconds) return { text: t('auth.locked', waitDescription(seconds, t)), retryAt: Date.now() + seconds * 1000 };
      return { text: t('errors.rate_limited'), retryAt: null };
    }
  }
  return { text: describeError(error, t), retryAt: null };
}
