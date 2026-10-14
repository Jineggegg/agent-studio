import { PROVIDERS_CHANGED_EVENT, PROVIDERS_TOPIC, type Provider } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Plus } from 'lucide-react';
import { useState } from 'react';
import { useStaleness } from '@/data/connection';
import { useRealtimeTopic } from '@/data/realtime';
import { useIsOwner } from '@/data/session';
import { type Translator, useT } from '@/i18n';
import { Badge, ErrorState, Glyph, List, ListRow, LoadingRow, StaleNotice } from '@/ui';
import { providerKeys, providersApi } from './api';
import { keyStatus } from './keyField';
import { checkText, hostOf, windowText } from './model';
import { ProviderSheet } from './ProviderSheet';
import './providers.css';

/** Keep provider lists (and the agents built from them) current: the server says when one changes. */
export function useProvidersLiveUpdates(): void {
  const queryClient = useQueryClient();
  useRealtimeTopic(PROVIDERS_TOPIC, (event) => {
    if (event.type !== PROVIDERS_CHANGED_EVENT) return;
    void queryClient.invalidateQueries({ queryKey: providerKeys.all });
    void queryClient.invalidateQueries({ queryKey: ['workbench', 'agents'] });
    void queryClient.invalidateQueries({ queryKey: ['usage', 'providers'] });
  });
}

function ownerSubtitle(provider: Provider, t: Translator): string {
  const settings = provider.settings;
  const parts = [hostOf(settings?.baseUrl ?? '')];
  const status = keyStatus(provider);
  parts.push(
    status === 'configured'
      ? t('providers.row.keyConfigured')
      : status === 'unreadable'
        ? t('providers.row.keyUnreadable')
        : status === 'not-needed'
          ? t('providers.row.keyNotNeeded')
          : t('providers.row.keyMissing'),
  );
  parts.push(t.plural('providers.row.models', provider.models.length));
  return parts.join(' · ');
}

/**
 * Models: the API providers this Studio talks to. The owner adds and manages
 * them — address, key (write-only), the model catalogue, balance — and
 * everyone else sees what they can use.
 */
export default function ProvidersPage() {
  const t = useT();
  const isOwner = useIsOwner();
  const [editing, setEditing] = useState<{ provider: Provider | null } | null>(null);
  const providers = useQuery({ queryKey: providerKeys.list, queryFn: ({ signal }) => providersApi.list(signal), meta: { live: true } });
  const presets = useQuery({ queryKey: providerKeys.presets, queryFn: ({ signal }) => providersApi.presets(signal), enabled: isOwner, staleTime: 10 * 60_000 });
  const { stale, since } = useStaleness(providers);
  useProvidersLiveUpdates();

  if (!providers.data) {
    if (providers.isError) return <ErrorState error={providers.error} onRetry={() => void providers.refetch()} retrying={providers.isFetching} compact />;
    return <LoadingRow label={t('common.loading')} />;
  }
  const list = providers.data.providers;
  // Show the sheet's newest copy of a provider once the list has been read again.
  const current = editing?.provider ? (list.find((entry) => entry.id === editing.provider!.id) ?? editing.provider) : null;

  if (!isOwner) {
    const usable = list.filter((provider) => provider.enabled);
    const off = list.filter((provider) => !provider.enabled);
    return (
      <div className="prv-page">
        {stale && <StaleNotice since={since} />}
        {usable.length === 0 ? (
          <List footer={t('providers.member.none')}>
            <ListRow leading={<Glyph icon={<Cpu size={18} />} tint="slate" />} title={t('providers.member.noneTitle')} />
          </List>
        ) : (
          usable.map((provider) => (
            <List key={provider.id} header={provider.name} footer={provider.configured ? t('providers.member.ready') : t('providers.member.notConfigured')}>
              {provider.models.map((model) => (
                <ListRow
                  key={model.id}
                  title={model.name}
                  subtitle={[windowText(model.contextWindow, t), model.images ? t('providers.model.images') : null, model.tools ? t('providers.model.tools') : null].filter(Boolean).join(' · ') || undefined}
                  trailing={model.id === provider.defaultModel ? <Badge tone="accent">{t('providers.catalogue.default')}</Badge> : undefined}
                />
              ))}
              {provider.models.length === 0 && <ListRow title={t('providers.member.noModels')} />}
            </List>
          ))
        )}
        {off.length > 0 && <p className="prv-note">{t('providers.member.off', { names: t.list(off.map((provider) => provider.name)) })}</p>}
      </div>
    );
  }

  return (
    <div className="prv-page">
      {stale && <StaleNotice since={since} />}
      <List header={t('providers.list.header')} footer={t('providers.list.footer')}>
        {list.map((provider) => {
          const check = provider.settings?.lastCheck ?? null;
          return (
            <ListRow
              key={provider.id}
              leading={<Glyph icon={<Cpu size={18} />} tint={provider.enabled ? 'purple' : 'slate'} />}
              title={provider.name}
              subtitle={ownerSubtitle(provider, t)}
              trailing={
                !provider.enabled ? (
                  <Badge tone="neutral">{t('providers.status.off')}</Badge>
                ) : keyStatus(provider) === 'missing' || keyStatus(provider) === 'unreadable' ? (
                  <Badge tone="warning">{t('providers.status.needsKey')}</Badge>
                ) : check ? (
                  <Badge tone={check.ok ? 'positive' : 'danger'}>{check.ok ? t('providers.status.ok') : t('providers.status.failing')}</Badge>
                ) : undefined
              }
              onPress={() => setEditing({ provider })}
              chevron
            />
          );
        })}
        <ListRow leading={<Glyph icon={<Plus size={18} />} tint="blue" />} title={t('providers.add.title')} subtitle={t('providers.add.text')} onPress={() => setEditing({ provider: null })} chevron />
      </List>
      {list.some((provider) => provider.settings?.lastCheck && !provider.settings.lastCheck.ok) && (
        <List header={t('providers.problems.header')}>
          {list
            .filter((provider) => provider.settings?.lastCheck && !provider.settings.lastCheck.ok)
            .map((provider) => (
              <ListRow key={provider.id} title={provider.name} subtitle={checkText(provider.settings!.lastCheck!, t)} onPress={() => setEditing({ provider })} chevron />
            ))}
        </List>
      )}
      <ProviderSheet open={editing !== null} provider={current} presets={presets.data?.presets ?? []} onClose={() => setEditing(null)} />
    </div>
  );
}
