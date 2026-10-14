import { INBOX_EVENT, userTopic } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useRealtimeTopic } from '@/data/realtime';
import { useUser } from '@/data/session';
import { useT } from '@/i18n';
import type { TileStatus } from '@/registry';
import { inboxApi, inboxKeys } from './api';

/** Re-read the inbox (and its summary) a moment after the server says it changed: bursts become one read. */
export function useInboxLiveUpdates(): void {
  const user = useUser();
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useRealtimeTopic(user ? userTopic(user.id) : null, (event) => {
    if (event.type !== INBOX_EVENT.inboxChanged && event.type !== INBOX_EVENT.notificationsChanged) return;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void queryClient.invalidateQueries({ queryKey: inboxKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['notifications', 'list'] });
    }, 300);
  });
}

/**
 * The inbox tile's line: what waits for the user, else new results, else
 * what is running, else "nothing waiting" — the server's summary, said in
 * the app's language. When the last check failed it says the line may be
 * out of date, unless something is waiting.
 */
export function useInboxTileStatus(): TileStatus | null {
  const t = useT();
  const summary = useQuery({ queryKey: inboxKeys.summary, queryFn: ({ signal }) => inboxApi.summary(signal), meta: { live: true }, staleTime: 10_000 });
  useInboxLiveUpdates();
  const data = summary.data;
  if (!data) return summary.isError ? { text: t('inbox.tile.needsUpdate'), tone: 'neutral' } : null;
  const { code, count } = data.status;
  if (code === 'waiting') return { text: t.plural('inbox.tile.waiting', count), tone: 'attention' };
  if (summary.isError) return { text: t('inbox.tile.needsUpdate'), tone: 'neutral' };
  if (code === 'results') return { text: t.plural('inbox.tile.results', count), tone: 'positive' };
  if (code === 'running') return { text: t.plural('inbox.tile.running', count), tone: 'neutral' };
  return { text: t('inbox.tile.clear'), tone: 'neutral' };
}
