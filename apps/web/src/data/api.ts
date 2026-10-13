import { authStateSchema } from '@agent-studio/protocol';
import { createHttpClient, type HttpClient } from './http';
import { requestReauth } from './reauth';
import { applyAuthState, useSession } from './session';

export { ApiError, isApiError, type RequestOptions } from './http';

type UnauthorizedHandler = () => void;
let unauthorizedHandler: UnauthorizedHandler = () => {};

/** Wired once by `data/auth.ts`, which owns what "the session is over" means. */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  unauthorizedHandler = handler;
}

/**
 * The app's HTTP client. Use it for every request to the server:
 *
 *   const { projects } = await api.get('/api/projects', { schema });
 *   await api.patch(`/api/projects/${id}`, { name });
 *
 * See `./http.ts` for what it takes care of.
 */
export const api: HttpClient = createHttpClient({
  fetch: (input, init) => globalThis.fetch(input, init),
  getCsrfToken: () => useSession.getState().csrfToken,
  onUnauthorized: () => unauthorizedHandler(),
  requestReauth,
  refreshSession: async () => {
    const before = useSession.getState().csrfToken;
    try {
      const response = await globalThis.fetch('/api/auth/state', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return false;
      const state = authStateSchema.parse(await response.json());
      applyAuthState(state);
      return state.csrfToken !== null && state.csrfToken !== before;
    } catch {
      return false;
    }
  },
});
