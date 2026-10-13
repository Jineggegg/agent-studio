import { useEffect, useState } from 'react';
import { useBrowserOnline } from '@/platform/media';
import { useRealtimeState } from './realtime';
import { useSession } from './session';

/**
 * How well this tab can currently hear the server.
 *
 *  online        the live connection is up
 *  reconnecting  it is down and being re-established (a short gap is not reported)
 *  offline       the browser says there is no network at all
 */
export type ConnectionState = 'online' | 'reconnecting' | 'offline';

/** A gap shorter than this is normal on a phone and not worth mentioning. */
const GRACE_MS = 3_500;

export function useConnectionState(): ConnectionState {
  const browserOnline = useBrowserOnline();
  const authenticated = useSession((state) => state.authenticated);
  const realtime = useRealtimeState();
  const down = authenticated && (realtime.status === 'waiting' || realtime.status === 'connecting');
  const [overdue, setOverdue] = useState(false);

  useEffect(() => {
    if (!down) return;
    const elapsed = Date.now() - realtime.since;
    // A first connection gets the same patience as a reconnection.
    const timer = window.setTimeout(() => setOverdue(true), Math.max(0, GRACE_MS - (realtime.status === 'waiting' ? elapsed : 0)));
    return () => {
      window.clearTimeout(timer);
      setOverdue(false);
    };
    // `since` changes with every attempt; the grace period runs from when the trouble began.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [down]);

  if (!browserOnline && (down || !authenticated)) return 'offline';
  if (down && overdue) return 'reconnecting';
  return 'online';
}

export interface Staleness {
  /** The data on screen was not freshly read: label it. */
  stale: boolean;
  /** When it was read, ms since the epoch (0 when never). */
  since: number;
}

/**
 * Whether what a query shows should carry a "may be out of date" mark: its
 * last read failed while older data is still on screen, or the connection to
 * the server is down.
 *
 *   const projects = useQuery(…);
 *   const { stale, since } = useStaleness(projects);
 *   {stale && <StaleNotice since={since} />}
 */
export function useStaleness(query: { data: unknown; isError: boolean; dataUpdatedAt: number }): Staleness {
  const connection = useConnectionState();
  const hasData = query.data !== undefined;
  return { stale: hasData && (query.isError || connection !== 'online'), since: query.dataUpdatedAt };
}
