import {
  type AuthState,
  type LoginRequest,
  type SetupRequest,
  authStateSchema,
  userTopic,
} from '@agent-studio/protocol';
import { z } from 'zod';
import { api, isApiError, setUnauthorizedHandler } from './api';
import { beginPreferences, flushPreferences, forgetPreferences, handlePreferencesEvent, loadPreferences } from './preferences';
import { queryClient, refreshLiveQueries } from './query';
import { realtime, setRealtimeAuthEndedHandler } from './realtime';
import { settleReauth } from './reauth';
import {
  type SessionEndReason,
  applyAuthState,
  markSessionEnded,
  markSessionRecentlyAuthenticated,
  markSessionUnreachable,
  useSession,
} from './session';

/**
 * Signing in, signing out, and everything that has to happen around them.
 * Nothing else in the client starts or ends a session.
 */

const sessionEndListeners = new Set<(reason: SessionEndReason) => void>();
let stopUserTopic: (() => void) | null = null;
let lastForegroundRead = 0;

/**
 * Register cleanup for when the session ends (sign-out or expiry): features
 * erase whatever they keep on the device for the signed-in user — drafts,
 * caches, layout that names projects. Returns the function that unregisters.
 */
export function onSessionEnd(listener: (reason: SessionEndReason) => void): () => void {
  sessionEndListeners.add(listener);
  return () => sessionEndListeners.delete(listener);
}

function beginSession(state: AuthState): void {
  if (!state.authenticated || !state.user) return;
  const user = state.user;
  beginPreferences(user.id);
  void loadPreferences().catch(() => {
    /* the device's copy stays in use; the next foreground read tries again */
  });
  stopUserTopic?.();
  stopUserTopic = realtime.subscribe(userTopic(user.id), handlePreferencesEvent);
  realtime.start();
}

/**
 * A sign-in completed somewhere other than `signIn` (a passkey): start the
 * session's machinery. Call it after `applyAuthState`.
 */
export function beginSessionFromState(state: AuthState): void {
  beginSession(state);
}

/** Forget the session locally. The server is told separately (see `signOut`). */
export function endSession(reason: SessionEndReason): void {
  const wasAuthenticated = useSession.getState().authenticated;
  stopUserTopic?.();
  stopUserTopic = null;
  realtime.stop();
  settleReauth(false);
  forgetPreferences();
  queryClient.clear();
  markSessionEnded(reason);
  if (wasAuthenticated) for (const listener of [...sessionEndListeners]) listener(reason);
}

async function readState(): Promise<AuthState> {
  return api.get('/api/auth/state', { schema: authStateSchema, expectUnauthorized: true, timeoutMs: 10_000 });
}

/**
 * Ask the server who we are. Used at start-up and whenever that is in doubt.
 * A server that cannot be reached leaves the session as it was — it is never
 * a reason to sign anyone out — and one silent retry covers the common case
 * of a phone that has no network for a moment after waking.
 */
export async function loadSession(): Promise<void> {
  let state: AuthState;
  try {
    state = await readState();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 900));
    try {
      state = await readState();
    } catch {
      markSessionUnreachable();
      return;
    }
  }
  const before = useSession.getState();
  if (before.authenticated && !state.authenticated) {
    endSession('expired');
    applyAuthState(state);
    return;
  }
  applyAuthState(state);
  if (state.authenticated && (!before.authenticated || before.user?.id !== state.user?.id)) beginSession(state);
}

export async function signIn(credentials: LoginRequest): Promise<void> {
  const state = await api.post('/api/auth/login', credentials, { schema: authStateSchema, expectUnauthorized: true });
  applyAuthState(state);
  beginSession(state);
}

export async function setUp(input: SetupRequest): Promise<void> {
  const state = await api.post('/api/auth/setup', input, { schema: authStateSchema, expectUnauthorized: true });
  applyAuthState(state);
  beginSession(state);
}

/** Sign out on this device. The server ends the session; whatever it answers, this device forgets it. */
export async function signOut(): Promise<void> {
  try {
    await flushPreferences();
  } catch {
    /* not worth blocking sign-out for */
  }
  try {
    await api.post('/api/auth/logout', undefined, { expectUnauthorized: true, timeoutMs: 8_000 });
  } catch (error) {
    // Unreachable server: the cookie stays valid there, but this device must still forget. Anything else is final too.
    if (!isApiError(error)) throw error;
  }
  endSession('signed-out');
}

/**
 * Sign out everywhere: the server ends every session and API token of the
 * account, on every device, this one included.
 */
export async function signOutEverywhere(): Promise<void> {
  try {
    await flushPreferences();
  } catch {
    /* not worth blocking for */
  }
  // Unlike a plain sign-out this must reach the server: if it does not, nothing was revoked, and the caller hears about it.
  await api.post('/api/auth/logout-everywhere', undefined, { timeoutMs: 10_000 });
  endSession('signed-out');
}

/** The step-up check. Throws the server's error when the password is wrong or attempts are throttled. */
export async function confirmIdentity(password: string): Promise<void> {
  await api.post('/api/auth/reauth', { password }, { schema: z.object({ recentlyAuthenticated: z.boolean() }), expectUnauthorized: true, noReauth: true });
  markSessionRecentlyAuthenticated();
}

/**
 * Wire the data layer together. Called once from main.tsx, before the first
 * request.
 */
export function initializeData(): void {
  setUnauthorizedHandler(() => {
    if (useSession.getState().authenticated) endSession('expired');
  });

  // The server closed the live connection saying the session ended. Believe it,
  // but look once: if the session is in fact alive the connection is restarted.
  setRealtimeAuthEndedHandler(() => {
    void (async () => {
      try {
        const state = await readState();
        if (!state.authenticated) {
          if (useSession.getState().authenticated) endSession('expired');
          applyAuthState(state);
          return;
        }
        applyAuthState(state);
        setTimeout(() => {
          if (useSession.getState().authenticated) realtime.start();
        }, 5_000);
      } catch {
        if (useSession.getState().authenticated) endSession('expired');
      }
    })();
  });

  realtime.onReady(({ reconnected }) => {
    if (!reconnected) return;
    // Topics without numbered events cannot be replayed: re-read what they mirror.
    refreshLiveQueries();
    void loadPreferences().catch(() => {});
  });

  const onForeground = () => {
    if (document.visibilityState === 'hidden') {
      void flushPreferences(true).catch(() => {});
      return;
    }
    realtime.wake();
    if (!useSession.getState().authenticated) return;
    const now = Date.now();
    if (now - lastForegroundRead < 5_000) return;
    lastForegroundRead = now;
    void loadPreferences().catch(() => {});
  };
  document.addEventListener('visibilitychange', onForeground);
  window.addEventListener('pagehide', () => void flushPreferences(true).catch(() => {}));
  window.addEventListener('online', () => realtime.wake());
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      realtime.wake();
      void loadSession();
    }
  });
}
