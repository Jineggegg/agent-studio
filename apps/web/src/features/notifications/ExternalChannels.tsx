import {
  notificationChannelsSchema,
  notificationChannelResultSchema,
  type ExternalNotificationChannel,
} from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/data/api';
import { describeError } from '@/data/errors';
import { useT } from '@/i18n';
import {
  Button,
  ErrorState,
  Form,
  List,
  ListRow,
  LoadingRow,
  Select,
  Switch,
  TextField,
  confirm,
  toast,
} from '@/ui';
function ChannelForm({
  kind,
  saved,
}: {
  kind: 'smtp' | 'bark';
  saved: ExternalNotificationChannel | undefined;
}) {
  const t = useT(),
    cache = useQueryClient();
  const [enabled, setEnabled] = useState(saved?.enabled ?? false),
    [secret, setSecret] = useState(''),
    [busy, setBusy] = useState(false);
  const [host, setHost] = useState(saved?.kind === 'smtp' ? saved.host : ''),
    [username, setUsername] = useState(saved?.kind === 'smtp' ? saved.username : ''),
    [from, setFrom] = useState(saved?.kind === 'smtp' ? saved.from : ''),
    [to, setTo] = useState(saved?.kind === 'smtp' ? saved.to : ''),
    [endpoint, setEndpoint] = useState(saved?.kind === 'bark' ? saved.endpoint : '');
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await cache.invalidateQueries({ queryKey: ['notification-channels'] });
    } catch (e) {
      toast.error(describeError(e, t));
    } finally {
      setBusy(false);
    }
  };
  const save = () =>
    run(async () => {
      await api.put(
        '/api/notifications/channels',
        kind === 'smtp'
          ? {
              kind,
              enabled,
              host,
              port: 465,
              username,
              from,
              to,
              ...(secret ? { password: secret } : {}),
            }
          : { kind, enabled, endpoint, ...(secret ? { deviceKey: secret } : {}) },
        { schema: notificationChannelsSchema },
      );
      setSecret('');
      toast.success(t('notify.external.saved'));
    });
  const test = () =>
    run(async () => {
      if (
        !(await confirm({
          title: t('notify.external.confirm'),
          message: t('notify.external.confirmText'),
          confirmLabel: t('notify.external.test'),
        }))
      )
        return;
      await api.post(
        `/api/notifications/channels/${kind}/test`,
        { confirmed: true },
        { schema: notificationChannelResultSchema, timeoutMs: 30000 },
      );
      toast.success(t('notify.external.accepted'));
    });
  return (
    <Form onSubmit={save}>
      <div className="ntf-external-form">
        <Switch label={t('notify.external.enabled')} checked={enabled} onChange={setEnabled} />
        {kind === 'smtp' ? (
          <>
            <TextField label={t('notify.external.host')} value={host} onChange={setHost} />
            <TextField
              label={t('notify.external.username')}
              value={username}
              onChange={setUsername}
            />
            <TextField label={t('notify.external.from')} value={from} onChange={setFrom} />
            <TextField label={t('notify.external.to')} value={to} onChange={setTo} />
          </>
        ) : (
          <TextField
            label={t('notify.external.endpoint')}
            value={endpoint}
            onChange={setEndpoint}
          />
        )}
        <TextField
          type="password"
          secret
          label={t(kind === 'smtp' ? 'notify.external.password' : 'notify.external.key')}
          value={secret}
          onChange={setSecret}
          hint={t('notify.external.secretHint')}
        />
        <div className="ntf-external-actions">
          <Button type="submit" loading={busy}>
            {t('common.save')}
          </Button>
          <Button disabled={!saved || busy} onClick={() => void test()}>
            {t('notify.external.test')}
          </Button>
          {saved && (
            <Button
              variant="plain-danger"
              disabled={busy}
              onClick={() => void run(() => api.delete(`/api/notifications/channels/${kind}`))}
            >
              {t('notify.external.remove')}
            </Button>
          )}
        </div>
      </div>
    </Form>
  );
}
export function ExternalChannels() {
  const t = useT();
  const [kind, setKind] = useState<'smtp' | 'bark'>('smtp');
  const query = useQuery({
    queryKey: ['notification-channels'],
    queryFn: ({ signal }) =>
      api.get('/api/notifications/channels', { schema: notificationChannelsSchema, signal }),
  });
  const saved = query.data?.channels.find((c) => c.kind === kind);
  return (
    <section>
      <List header={t('notify.external.title')} footer={t('notify.external.help')}>
        <ListRow
          title={t('notify.external.kind')}
          control={
            <Select
              label={t('notify.external.kind')}
              value={kind}
              onChange={setKind}
              options={[
                { value: 'smtp', label: 'SMTP' },
                { value: 'bark', label: 'Bark' },
              ]}
            />
          }
        />
      </List>
      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !query.data ? (
        <LoadingRow label={t('common.loading')} />
      ) : (
        <ChannelForm key={`${kind}:${Boolean(saved)}`} kind={kind} saved={saved} />
      )}
    </section>
  );
}
