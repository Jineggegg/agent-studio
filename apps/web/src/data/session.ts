import type { AuthState, User } from '@agent-studio/protocol';
import { create } from 'zustand';

/**
 * Who is signed in, as far as this tab knows.
 *
 * `status` walks: `loading` → (`ready` | `unreachable`). While it is `loading`
 * the launch screen stays up, so neither the sign-in form nor the workspace
 * can flash before the answer is in.
 */
export type SessionStatus = 'loading' | 'ready' | 'unreachable';

/** Why the sign-in screen is showing, when it is not simply a first visit. */
export type SessionEndReason = 'expired' | 'signed-out' | null;

export interface SessionState {
  status: SessionStatus;
  needsSetup: boolean;
  authenticated: boolean;
  user: User | null;
  csrfToken: string | null;
  session: AuthState['session'];
  /** Whether passkeys can be used at the address this page was loaded from. */
  passkeysAvailable: boolean;
  /** The server's version string. */
  serverVersion: string | null;
  /** serverTime − Date.now() at the last state read, to correct a wrong device clock. */
  clockSkewMs: number;
  endReason: SessionEndReason;
}

const initial: SessionState = {
  status: 'loading',
  needsSetup: false,
  authenticated: false,
  user: null,
  csrfToken: null,
  session: null,
  passkeysAvailable: false,
  serverVersion: null,
  clockSkewMs: 0,
  endReason: null,
};

export const useSession = create<SessionState>(() => initial);

/** Applies an answer from the server. */
export function applyAuthState(state: AuthState): void {
  useSession.setState((previous) => ({
    status: 'ready',
    needsSetup: state.needsSetup,
    authenticated: state.authenticated,
    user: state.user,
    csrfToken: state.csrfToken,
    session: state.session,
    passkeysAvailable: state.passkeysAvailable,
    serverVersion: state.version,
    clockSkewMs: state.serverTime - Date.now(),
    endReason: state.authenticated ? null : previous.endReason,
  }));
}

export function markSessionUnreachable(): void {
  // Only start-up can end here. Later on, what we knew stays as it is: an
  // unreachable server never signs anyone out, and never takes the app away.
  if (useSession.getState().status === 'loading') useSession.setState({ status: 'unreachable' });
}


export function markSessionEnded(reason: SessionEndReason): void {
  useSession.setState((previous) => ({
    ...previous,
    status: 'ready',
    authenticated: false,
    user: null,
    csrfToken: null,
    session: null,
    endReason: reason,
  }));
}

export function markSessionRecentlyAuthenticated(): void {
  useSession.setState((previous) =>
    previous.session
      ? { session: { ...previous.session, recentlyAuthenticated: true, authenticatedAt: Date.now() + previous.clockSkewMs } }
      : previous,
  );
}

export const useUser = (): User | null => useSession((state) => state.user);
export const useIsOwner = (): boolean => useSession((state) => state.user?.role === 'owner');

/** For tests. */
export function resetSessionStore(): void {
  useSession.setState(initial, true);
}
