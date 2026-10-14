import type { PluginContributions } from '@agent-studio/protocol';
import { useQuery } from '@tanstack/react-query';
import { queryClient } from '@/data/query';
import { useT } from '@/i18n';
import { pluginKeys, pluginsApi } from './api';

/** For the plugins page's row in settings: how many plugins are on. */
export function usePluginsSummary(): string | undefined {
  const t = useT();
  const list = useQuery({ queryKey: pluginKeys.list, queryFn: ({ signal }) => pluginsApi.list(signal), staleTime: 60_000 });
  if (!list.data) return undefined;
  const on = list.data.plugins.filter((plugin) => plugin.enabled).length;
  return list.data.plugins.length === 0 ? t('plugins.summary.none') : t('plugins.summary.on', { on: t.number(on), total: t.number(list.data.plugins.length) });
}

/** Whether any enabled plugin offers a tab in projects, as far as this client has read. */
export function hasProjectTabs(): boolean {
  return (queryClient.getQueryData<PluginContributions>(pluginKeys.contributions)?.projectTabs.length ?? 0) > 0;
}

/** Calls `listener` whenever the number of project tabs read from the server changes. */
export function onProjectTabsChange(listener: () => void): () => void {
  let last = -1;
  return queryClient.getQueryCache().subscribe((event) => {
    const key = event.query.queryKey;
    if (key[0] !== pluginKeys.contributions[0] || key[1] !== pluginKeys.contributions[1]) return;
    const count = (event.query.state.data as PluginContributions | undefined)?.projectTabs.length ?? 0;
    if (count === last) return;
    last = count;
    listener();
  });
}
