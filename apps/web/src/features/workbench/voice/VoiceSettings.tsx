import { voiceSettingsSchema } from '@agent-studio/protocol';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/data/api';
import { useT } from '@/i18n';
import { ErrorState, LoadingRow } from '@/ui';
import '../media/media.css';
export default function VoiceSettings() {
  const t = useT();
  const query = useQuery({
    queryKey: ['voice-settings'],
    queryFn: () => api.get('/api/voice/settings', { schema: voiceSettingsSchema }),
  });
  const [form, setForm] = useState<{
    enabled: boolean;
    endpoint: string;
    model: string;
    allowPrivateNetwork: boolean;
  } | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  if (!query.data)
    return query.isPending ? (
      <LoadingRow label={t('common.loading')} />
    ) : (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  const value = form ?? query.data;
  const update = (change: Partial<typeof value>) => {
    setForm({ ...value, ...change });
    setSaved(false);
  };
  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await api.put(
        '/api/voice/settings',
        {
          enabled: value.enabled,
          endpoint: value.endpoint,
          model: value.model,
          allowPrivateNetwork: value.allowPrivateNetwork,
          removeKey,
          ...(apiKey ? { apiKey } : {}),
        },
        { schema: voiceSettingsSchema },
      );
      setApiKey('');
      setRemoveKey(false);
      setSaved(true);
      await query.refetch();
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="wb-annotation" style={{ position: 'static' }}>
      <p>{t('voice.configHint')}</p>
      <label className="wb-annotation__tools">
        <input
          type="checkbox"
          checked={value.enabled}
          onChange={(event) => update({ enabled: event.target.checked })}
        />
        {t('voice.enabled')}
      </label>
      <label className="wb-annotation__instruction">
        {t('voice.endpoint')}
        <input
          type="url"
          value={value.endpoint}
          autoComplete="off"
          onChange={(event) => update({ endpoint: event.target.value })}
        />
      </label>
      <label className="wb-annotation__instruction">
        {t('voice.model')}
        <input
          value={value.model}
          maxLength={120}
          onChange={(event) => update({ model: event.target.value })}
        />
      </label>
      <label className="wb-annotation__instruction">
        {t('voice.key')}
        <input
          type="password"
          value={apiKey}
          autoComplete="new-password"
          onChange={(event) => setApiKey(event.target.value)}
        />
      </label>
      {query.data.keyConfigured && (
        <label className="wb-annotation__tools">
          <input
            type="checkbox"
            checked={removeKey}
            onChange={(event) => setRemoveKey(event.target.checked)}
          />
          {t('voice.removeKey')}
        </label>
      )}
      <label className="wb-annotation__tools">
        <input
          type="checkbox"
          checked={value.allowPrivateNetwork}
          onChange={(event) => update({ allowPrivateNetwork: event.target.checked })}
        />
        {t('voice.private')}
      </label>
      <button
        type="button"
        disabled={saving || (value.enabled && !value.endpoint)}
        onClick={() => void save()}
      >
        {t('voice.save')}
      </button>
      {saved && <p role="status">{t('voice.saved')}</p>}
      {error !== null && <ErrorState error={error} compact />}
    </section>
  );
}
