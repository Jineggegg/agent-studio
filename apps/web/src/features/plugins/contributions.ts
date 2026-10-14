import { PLUGINS_CHANGED_EVENT, PLUGINS_TOPIC, type PluginContributions } from '@agent-studio/protocol';
import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRealtimeTopic } from '@/data/realtime';
import { useUser } from '@/data/session';
import { pluginKeys, pluginsApi } from './api';

/**
 * What enabled plugins add to the interface — launcher tiles, project tabs,
 * settings pages, links — for every signed-in user. Read once and kept
 * current from the `system:plugins` topic: an owner enabling or removing a
 * plugin changes every open client within a moment.
 */
export function usePluginContributions(options: { enabled?: boolean } = {}): UseQueryResult<PluginContributions> {
  const user = useUser();
  return useQuery({
    queryKey: pluginKeys.contributions,
    queryFn: ({ signal }) => pluginsApi.contributions(signal),
    enabled: (options.enabled ?? true) && user !== null,
    staleTime: 5 * 60_000,
    meta: { live: true },
  });
}

/** Mount once, where the app always is (the launcher): re-reads what plugins offer when the owner changes them. */
export function usePluginsLiveUpdates(): void {
  const user = useUser();
  const queryClient = useQueryClient();
  useRealtimeTopic(user ? PLUGINS_TOPIC : null, (event) => {
    if (event.type === PLUGINS_CHANGED_EVENT) void queryClient.invalidateQueries({ queryKey: pluginKeys.all });
  });
}

export const EMPTY_CONTRIBUTIONS: PluginContributions = { homeTiles: [], projectTabs: [], settingsPages: [], linkTiles: [] };
