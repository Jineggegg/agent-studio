import type { Provider, ProviderKeyProblem, UpdateProviderResponse } from '@agent-studio/protocol';
import type { MessageKey } from '@/i18n';

/**
 * How the API-key field behaves. A saved key can never be read back, so:
 *
 *  - the field is never filled from the server — it always starts empty;
 *  - leaving it blank keeps the saved key (nothing is sent);
 *  - typing replaces the saved key, and the form says so before saving;
 *  - changing the address removes the saved key on the server, and the form
 *    says so before saving — and again, from the server's own `keyCleared`,
 *    after.
 */

export type KeyStatus = 'configured' | 'missing' | 'unreadable' | 'not-needed';

export function keyStatus(provider: Pick<Provider, 'configured' | 'settings'> | null): KeyStatus {
  const settings = provider?.settings;
  if (!settings) return 'missing';
  if (settings.key.configured && !settings.key.readable) return 'unreadable';
  if (settings.key.configured) return 'configured';
  return settings.keyRequired ? 'missing' : 'not-needed';
}

/** What the empty field says about the saved key. Never any part of the key: the server sends none. */
export function keyPlaceholder(status: KeyStatus): MessageKey {
  switch (status) {
    case 'configured':
      return 'providers.key.placeholderKeep';
    case 'unreadable':
      return 'providers.key.placeholderUnreadable';
    case 'not-needed':
      return 'providers.key.placeholderOptional';
    case 'missing':
      return 'providers.key.placeholderRequired';
  }
}

/** The part of a save that is about the key: a typed key is sent as typed; a blank field sends nothing and keeps the saved one. */
export function keyPatch(typed: string): { apiKey?: string } {
  return typed.trim() === '' ? {} : { apiKey: typed };
}

/** Two addresses are the same server when they differ only by spacing or a trailing slash. */
export function sameBaseUrl(a: string, b: string): boolean {
  const clean = (value: string) => value.trim().replace(/\/+$/, '');
  return clean(a) === clean(b);
}

/**
 * What the form warns about before saving: the saved key will be removed
 * (the address changed and no new key was typed), or replaced (a new key was
 * typed), or nothing.
 */
export function keyWarning(input: { originalBaseUrl: string | null; baseUrl: string; keyConfigured: boolean; typed: string }): 'will-clear' | 'will-replace' | null {
  const typed = input.typed.trim() !== '';
  if (input.originalBaseUrl !== null && input.keyConfigured && !typed && !sameBaseUrl(input.originalBaseUrl, input.baseUrl)) return 'will-clear';
  if (typed && input.keyConfigured) return 'will-replace';
  return null;
}

/** What to tell the owner after a save, from what was sent and the server's answer. */
export function keyOutcome(response: Pick<UpdateProviderResponse, 'keyCleared'>, sentKey: boolean): 'key-cleared' | 'key-saved' | null {
  if (response.keyCleared && !sentKey) return 'key-cleared';
  if (sentKey) return 'key-saved';
  return null;
}

const PROBLEMS: readonly ProviderKeyProblem[] = ['empty', 'too_short', 'too_long', 'whitespace', 'characters', 'looks_like_url', 'sign_in_token', 'admin_key', 'other_service'];

/** Why the server refused a key (`details.reason` of `invalid_api_key`), as a message key. The value is never repeated. */
export function keyProblemKey(details: unknown): MessageKey {
  const reason = (details as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === 'string' && (PROBLEMS as readonly string[]).includes(reason) ? (`providers.keyProblem.${reason as ProviderKeyProblem}` as MessageKey) : 'providers.keyProblem.other';
}
