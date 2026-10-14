import { useQuery } from '@tanstack/react-query';
import { providerKeys, providersApi } from '@/features/providers/api';

/** The API providers, as the Models page reads them (the same cache entry): for the owner, with their settings. */
export function useProviders(enabled = true) {
  return useQuery({
    queryKey: providerKeys.list,
    queryFn: ({ signal }) => providersApi.list(signal),
    select: (data) => data.providers,
    enabled,
    staleTime: 60_000,
  });
}
