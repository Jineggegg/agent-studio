import { PASSWORD_MIN_LENGTH } from '@agent-studio/protocol';
import type { Translator } from '@/i18n';

/**
 * The server's rules for usernames and passwords (packages/protocol/src/auth.ts),
 * checked here first so the form can answer in the user's language before
 * anything is sent. The server checks again and has the last word.
 */
export interface AccountErrors {
  username?: string;
  password?: string;
  confirmation?: string;
}

const USERNAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
export const USERNAME_MIN = 2;
export const USERNAME_MAX = 40;
export const PASSWORD_MAX = 256;

export function checkUsername(value: string, t: Translator): string | undefined {
  const username = value.trim();
  if (username === '') return t('validation.username.missing');
  if (username.length < USERNAME_MIN) return t('validation.username.short', { count: USERNAME_MIN });
  if (username.length > USERNAME_MAX) return t('validation.username.long', { count: USERNAME_MAX });
  if (!USERNAME_PATTERN.test(username)) return t('validation.username.characters');
  return undefined;
}

export function checkNewPassword(value: string, t: Translator): string | undefined {
  if (value === '') return t('validation.password.missing');
  if (value.length < PASSWORD_MIN_LENGTH) return t('validation.password.short', { count: PASSWORD_MIN_LENGTH });
  if (value.length > PASSWORD_MAX) return t('validation.password.long', { count: PASSWORD_MAX });
  return undefined;
}

/** Checks in the order a person fills the form in; every failing field gets its own message. */
export function checkAccountFields(input: { username?: string; password: string; confirmation?: string }, t: Translator): AccountErrors {
  const errors: AccountErrors = {};
  if (input.username !== undefined) {
    const username = checkUsername(input.username, t);
    if (username) errors.username = username;
  }
  const password = checkNewPassword(input.password, t);
  if (password) errors.password = password;
  if (input.confirmation !== undefined && !password && input.confirmation !== input.password) errors.confirmation = t('validation.password.mismatch');
  return errors;
}
