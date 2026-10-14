import { Cpu } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useT } from '@/i18n';
import { registerSettingsPage } from '@/registry';
import { providerKeys, providersApi } from './api';

/** How many providers are on offer, for the page's row in the settings list. */
function useProvidersSummary(): string | undefined {
  const t = useT();
  const providers = useQuery({ queryKey: providerKeys.list, queryFn: ({ signal }) => providersApi.list(signal), staleTime: 60_000 });
  if (!providers.data) return undefined;
  const enabled = providers.data.providers.filter((provider) => provider.enabled).length;
  return enabled === 0 ? t('providers.summary.none') : t.plural('providers.summary.count', enabled);
}

/**
 * Models: the API providers (DeepSeek, OpenAI, a model server of your own)
 * the Studio drives as agents. The owner manages them; everyone else sees
 * what they can use. Registration only.
 */
registerSettingsPage({
  id: 'models',
  title: 'providers.title',
  icon: Cpu,
  tint: 'purple',
  group: 'assistants',
  order: 5,
  load: () => import('./ProvidersPage'),
  useSummary: useProvidersSummary,
});
