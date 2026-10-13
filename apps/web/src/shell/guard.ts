/**
 * Which screens a visitor may be on, given what the server said about them.
 * A pure function so the rules can be read (and tested) in one place.
 */
export type Zone =
  /** First-run setup. */
  | 'setup'
  /** Sign-in. */
  | 'login'
  /** Everything behind sign-in. */
  | 'app'
  /** Needs no session at all (the development gallery). */
  | 'open';

export interface GuardInput {
  zone: Zone;
  needsSetup: boolean;
  authenticated: boolean;
  /** The current address (path, query and fragment). */
  current: string;
  /** Where the visitor was headed before being sent to sign in. */
  intended: string | null;
}

export interface Redirect {
  to: string;
  /** Carried to the sign-in screen so it can return the visitor afterwards. */
  from?: string;
}

/** Only same-origin paths are ever followed after sign-in. */
export function safeInternalPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  if (value === '/login' || value.startsWith('/login?') || value === '/setup') return null;
  return value;
}

export function resolveRedirect({ zone, needsSetup, authenticated, current, intended }: GuardInput): Redirect | null {
  if (zone === 'open') return null;
  if (needsSetup) return zone === 'setup' ? null : { to: '/setup' };
  if (zone === 'setup') return { to: authenticated ? '/' : '/login' };
  if (zone === 'login') return authenticated ? { to: safeInternalPath(intended) ?? '/' } : null;
  if (!authenticated) {
    const from = safeInternalPath(current);
    return from && from !== '/' ? { to: '/login', from } : { to: '/login' };
  }
  return null;
}
