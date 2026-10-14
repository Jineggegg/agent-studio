import { useQuery } from '@tanstack/react-query';
import { deviceTimeZone } from '@/features/automation/time';
import { useT } from '@/i18n';
import type { TileStatus } from '@/registry';
import { usageApi, usageKeys } from './api';
import { compactNumber } from './shape';

/**
 * The usage tile's line: the fullest plan window an agent reported (or a
 * budget near its mark), else this month's tokens. Said from the summary the
 * server prepares for exactly this.
 */
export function useUsageTileStatus(): TileStatus | null {
  const t = useT();
  const zone = deviceTimeZone();
  const summary = useQuery({ queryKey: usageKeys.summary(zone), queryFn: ({ signal }) => usageApi.summary(zone, signal), staleTime: 60_000, meta: { live: true } });
  const data = summary.data;
  if (!data) return null;
  const measured = data.agents.filter((agent) => agent.fraction !== null && (agent.basis === 'quota' || agent.basis === 'budget'));
  const top = measured.sort((a, b) => (b.fraction ?? 0) - (a.fraction ?? 0))[0];
  if (top && top.fraction !== null) {
    const percent = t.number(Math.round(top.fraction * 100));
    const tone = top.fraction >= 1 ? 'danger' : top.fraction >= 0.8 ? 'attention' : 'neutral';
    // One short line under the tile: which agent (or budget) it is, the screen says.
    return { text: t('usage.tile.fraction', { percent }), tone };
  }
  const tokens = data.agents.reduce((sum, agent) => sum + agent.month.totalTokens, 0);
  return tokens > 0 ? { text: t('usage.tile.month', { tokens: compactNumber(tokens, t) }), tone: 'neutral' } : null;
}
