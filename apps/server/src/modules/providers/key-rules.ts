import { PROVIDER_LIMITS, type ProviderKeyProblem } from '@agent-studio/protocol';

/**
 * What may be saved as the API key of an OpenAI-compatible provider.
 *
 * The rule, in order:
 *
 * 1. Surrounding white space is dropped; what is left must not be empty.
 * 2. No white space or control characters inside, and only printable ASCII —
 *    the key travels in an HTTP header, so anything else is either a paste
 *    accident or an attempt to smuggle a second header.
 * 3. Between {@link PROVIDER_LIMITS.keyMinChars} and
 *    {@link PROVIDER_LIMITS.keyMaxChars} characters.
 * 4. Not something that is plainly a different kind of credential:
 *    - an address (`https://…`) pasted into the wrong field;
 *    - a **sign-in token** of a subscription or a browser session — Anthropic's
 *      `sk-ant-oat…` / `sk-ant-sid…`, OpenAI's `sess-…`, a refresh token
 *      (`rt_…`), or a JSON Web Token (three base64 parts starting `eyJ`), which
 *      is what "sign in with …" hands out. Such a token belongs to a person's
 *      subscription, not to the pay-per-use API, and must never be parked here;
 *    - an **organisation admin key** (`sk-admin-…`, `sk-ant-admin…`), which
 *      manages an organisation instead of calling models;
 *    - a credential of an unrelated service: GitHub tokens, Slack tokens, AWS
 *      access key ids, this Studio's own API tokens, a private-key block.
 *
 * Everything else is accepted: providers and self-hosted servers use too many
 * key shapes to demand one. The answer names the *kind* of problem and never
 * repeats any part of what was pasted.
 */
export type KeyCheck = { readonly ok: true; readonly key: string } | { readonly ok: false; readonly problem: ProviderKeyProblem; readonly message: string };

const refuse = (problem: ProviderKeyProblem, message: string): KeyCheck => ({ ok: false, problem, message });

const SIGN_IN_TOKEN = [/^sk-ant-oat/i, /^sk-ant-sid/i, /^sess-/i, /^rt_[A-Za-z0-9]/, /^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*$/];
const ADMIN_KEY = [/^sk-admin-/i, /^sk-ant-admin/i];
const OTHER_SERVICE = [/^gh[pousr]_/, /^github_pat_/, /^glpat-/, /^xox[abeprs]-/, /^AKIA[0-9A-Z]{16}$/, /^ast_/, /^-----BEGIN/];

export function checkApiKey(raw: string): KeyCheck {
  const key = raw.trim();
  if (key === '') return refuse('empty', 'Type or paste the API key.');
  if (/\s/.test(key)) return refuse('whitespace', 'An API key has no spaces or line breaks in it. Paste the key alone.');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(key)) return refuse('looks_like_url', 'That is an address, not an API key.');
  if (!/^[\x21-\x7e]+$/.test(key)) return refuse('characters', 'An API key consists of plain letters, digits and punctuation only.');
  if (key.length < PROVIDER_LIMITS.keyMinChars) return refuse('too_short', `That is too short to be an API key (fewer than ${PROVIDER_LIMITS.keyMinChars} characters).`);
  if (key.length > PROVIDER_LIMITS.keyMaxChars) return refuse('too_long', `That is too long to be an API key (more than ${PROVIDER_LIMITS.keyMaxChars} characters).`);
  if (ADMIN_KEY.some((pattern) => pattern.test(key))) {
    return refuse('admin_key', 'That is an organisation admin key. It manages an organisation and cannot be used to call models: create an ordinary API key instead.');
  }
  if (SIGN_IN_TOKEN.some((pattern) => pattern.test(key))) {
    return refuse('sign_in_token', 'That is a sign-in token of a subscription or a browser session, not an API key. Create an API key in the provider\'s developer console.');
  }
  if (OTHER_SERVICE.some((pattern) => pattern.test(key))) {
    return refuse('other_service', 'That is a credential of another service, not an API key of a model provider.');
  }
  return { ok: true, key };
}
