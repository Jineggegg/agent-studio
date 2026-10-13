import { type AuthState, type Passkey, authStateSchema, passkeyListSchema, passkeySchema } from '@agent-studio/protocol';
import { WebAuthnError, browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { z } from 'zod';
import { api } from '@/data/api';

/**
 * Passkeys (WebAuthn), as far as the client is concerned.
 *
 * The options the server issues are passed to the browser untouched and the
 * browser's answer is passed back untouched; this module only moves them.
 * A challenge lives for 60 s, so options are fetched ahead of the tap that
 * uses them: the system sheet must open directly from the tap, with no
 * request in between (iOS refuses otherwise).
 */

type RegistrationOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];
type AuthenticationOptions = Parameters<typeof startAuthentication>[0]['optionsJSON'];

/** Options from the server: an object with a challenge. The browser validates the rest. */
const optionsSchema = z.looseObject({ challenge: z.string() });

/** How long fetched options are trusted before fresh ones are asked for (the server's limit is 60 s). */
export const OPTIONS_FRESH_MS = 45_000;

export const passkeysSupportedHere = (): boolean => browserSupportsWebAuthn();

export async function fetchLoginOptions(signal?: AbortSignal): Promise<AuthenticationOptions> {
  return (await api.post('/api/auth/passkeys/login-options', undefined, { schema: optionsSchema, expectUnauthorized: true, ...(signal ? { signal } : {}) })) as unknown as AuthenticationOptions;
}

/** Opens the system passkey sheet and, when the user goes through with it, signs in. */
export async function signInWithPasskey(options: AuthenticationOptions): Promise<AuthState> {
  const response = await startAuthentication({ optionsJSON: options });
  return api.post('/api/auth/passkeys/login', { response }, { schema: authStateSchema, expectUnauthorized: true });
}

export async function listPasskeys(): Promise<{ available: boolean; passkeys: Passkey[] }> {
  return api.get('/api/auth/passkeys', { schema: passkeyListSchema });
}

export async function fetchRegistrationOptions(): Promise<RegistrationOptions> {
  return (await api.post('/api/auth/passkeys/registration-options', undefined, { schema: optionsSchema })) as unknown as RegistrationOptions;
}

/** Opens the system sheet to create a passkey on this device and registers it with the account. */
export async function registerPasskey(options: RegistrationOptions, name: string | undefined): Promise<Passkey> {
  const response = await startRegistration({ optionsJSON: options });
  return api.post('/api/auth/passkeys/registration', { response, ...(name ? { name } : {}) }, { schema: passkeySchema });
}

export async function removePasskey(id: string): Promise<void> {
  await api.delete(`/api/auth/passkeys/${id}`);
}

export type PasskeyFailure =
  /** The user closed the system sheet, or it timed out. Not an error: say so neutrally. */
  | 'cancelled'
  /** This authenticator already holds a passkey for the account. */
  | 'exists'
  /** The address cannot use passkeys (no https, an IP address). */
  | 'unavailable'
  | 'failed';

/** Sorts what the browser threw into what the user should be told. Server errors are not handled here. */
export function passkeyFailure(error: unknown): PasskeyFailure | null {
  if (error instanceof WebAuthnError) {
    if (error.code === 'ERROR_CEREMONY_ABORTED') return 'cancelled';
    if (error.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED') return 'exists';
    if (error.code === 'ERROR_INVALID_DOMAIN' || error.code === 'ERROR_INVALID_RP_ID') return 'unavailable';
    if (error.code === 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY' && error.cause instanceof Error && error.cause.name === 'NotAllowedError') return 'cancelled';
    return 'failed';
  }
  if (error instanceof Error) {
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') return 'cancelled';
    if (error.name === 'InvalidStateError') return 'exists';
    if (error.name === 'SecurityError') return 'unavailable';
    if (error.name === 'NotSupportedError') return 'failed';
  }
  return null;
}
