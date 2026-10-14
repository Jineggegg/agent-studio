import { useQuery } from '@tanstack/react-query';
import { useT } from '@/i18n';
import type { TileStatus } from '@/registry';
import { memoryApi, memoryKeys } from './api';

/** The memory tile's line: how many notes there are, or that memory cannot be read right now. */
export function useMemoryTileStatus(): TileStatus | null {
  const t = useT();
  const status = useQuery({ queryKey: memoryKeys.status, queryFn: ({ signal }) => memoryApi.status(signal), staleTime: 60_000, meta: { live: true } });
  const data = status.data;
  if (!data) return status.isError ? { text: t('memory.tile.unreachable'), tone: 'neutral' } : null;
  if (!data.healthy) return { text: t('memory.tile.problem'), tone: 'danger' };
  return { text: t.plural('memory.tile.notes', data.notes), tone: 'neutral' };
}
