import { useQuery } from '@tanstack/react-query';
import { useT } from '@/i18n';
import type { TileStatus } from '@/registry';
import { useScreenActive } from '@/shell/ScreenStack';
import { collabApi, collabKeys } from '../api';
import { useCollabLiveUpdates } from '../live';

/** What is running, read every so often while on screen; the live topic makes it prompt. */
export function useRunningWork(options: { enabled?: boolean; pollMs?: number } = {}) {
  const active = useScreenActive();
  return useQuery({
    queryKey: collabKeys.running,
    queryFn: ({ signal }) => collabApi.running(signal),
    enabled: options.enabled ?? true,
    staleTime: 10_000,
    meta: { live: true },
    refetchInterval: options.pollMs && active ? options.pollMs : false,
  });
}

/** The running tile's line: what waits for the user, else what runs. Null while unknown. */
export function useRunningTileStatus(): TileStatus | null {
  const t = useT();
  useCollabLiveUpdates({ running: true });
  // The live topic says when runs start and end; the slow poll only catches what it cannot (another device's automation).
  const running = useRunningWork({ pollMs: 60_000 });
  const data = running.data;
  if (!data) return null;
  if (data.counts.waiting > 0) return { text: t.plural('collab.running.tileWaiting', data.counts.waiting), tone: 'attention' };
  const total = data.counts.runs + data.counts.tasks;
  if (total > 0) return { text: t.plural('collab.running.tileRunning', data.counts.runs + data.counts.tasks), tone: 'positive' };
  return null;
}
