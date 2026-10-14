import { useQueryClient } from '@tanstack/react-query';
import { USER_AGENT_EVENT, userTopic } from '@agent-studio/protocol';
import { useRef } from 'react';
import { useRealtimeTopic } from '@/data/realtime';
import { useUser } from '@/data/session';
import { useT } from '@/i18n';
import type { TileStatus } from '@/registry';
import { activityTotals } from './sessions/grouping';
import { useActivity, workbenchKeys } from './sessions/queries';

const AGENT_EVENTS = new Set<string>(Object.values(USER_AGENT_EVENT));

/**
 * The line under the workbench's tile on the home screen: what needs the
 * user first, then what is running, then what finished unseen. It follows
 * the live connection, so the tile is right without opening the workbench.
 */
export function useWorkbenchTileStatus(): TileStatus | null {
  const t = useT();
  const user = useUser();
  const queryClient = useQueryClient();
  const activity = useActivity();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useRealtimeTopic(user ? userTopic(user.id) : null, (event) => {
    if (!AGENT_EVENTS.has(event.type) || event.type === USER_AGENT_EVENT.draftChanged || timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void queryClient.invalidateQueries({ queryKey: workbenchKeys.activity });
    }, 400);
  });

  // Nothing is said while the answer is unknown, so the line never flickers through a wrong value.
  if (!activity.data) return null;
  const totals = activityTotals(activity.data);
  if (totals.attention > 0) return { text: t.plural('workbench.tile.attention', totals.attention), tone: 'attention' };
  if (totals.running > 0) return { text: t.plural('workbench.tile.running', totals.running), tone: 'positive' };
  if (totals.unseen > 0) return { text: t.plural('workbench.tile.unseen', totals.unseen), tone: 'neutral' };
  return null;
}
