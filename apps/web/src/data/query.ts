import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './http';

/**
 * Query defaults chosen for a phone on a flaky connection talking to a small
 * home server:
 *
 *  - data is fresh for 30 s, so moving between screens does not re-ask;
 *  - coming back to the page re-reads only what is on screen and stale;
 *  - interval polling stops while the page is hidden;
 *  - a failed read is retried twice, and only when retrying can help (the
 *    server was unreachable or failed) — never on "not found" or "forbidden";
 *  - requests are attempted whatever `navigator.onLine` claims: a self-hosted
 *    server on the same machine or LAN is reachable without the internet.
 *
 * Mark a query `meta: { live: true }` when it mirrors live status; those are
 * re-read the moment the realtime connection comes back.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 10 * 60_000,
      networkMode: 'always',
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      refetchIntervalInBackground: false,
      retry: (failureCount, error) => {
        if (failureCount >= 2) return false;
        if (!isApiError(error)) return false;
        if (error.code === 'aborted' || error.status === 429) return false;
        return error.unreachable;
      },
      retryDelay: (attempt) => Math.min(800 * 2 ** attempt, 6_000),
    },
    mutations: {
      networkMode: 'always',
      retry: false,
    },
  },
});

declare module '@tanstack/react-query' {
  interface Register {
    queryMeta: {
      /** Mirrors live status: re-read when the realtime connection returns. */
      live?: boolean;
    };
  }
}

/** Re-reads every on-screen query that mirrors live status. Called when the live connection returns. */
export function refreshLiveQueries(): void {
  void queryClient.invalidateQueries({ predicate: (query) => query.meta?.live === true });
}
