import type { DeviceSession } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor, Smartphone, Tablet } from 'lucide-react';
import { api } from '@/data/api';
import { describeError } from '@/data/errors';
import { useT } from '@/i18n';
import { Badge, ErrorState, List, ListRow, LoadingRow, confirm, toast } from '@/ui';
import { describeUserAgent, settingsKeys, useDeviceSessions } from '../../api';

function deviceIcon(userAgent: string | null) {
  if (userAgent && /iPhone|Android.*Mobile/.test(userAgent)) return <Smartphone size={20} />;
  if (userAgent && /iPad|Android/.test(userAgent)) return <Tablet size={20} />;
  return <Monitor size={20} />;
}

/** Where this account is signed in, with this device marked, and a way to sign any other one out. */
export function DevicesSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const sessions = useDeviceSessions();

  const signOutDevice = async (session: DeviceSession, name: string) => {
    const confirmed = await confirm({
      title: t('account.devices.signOut.title', { name }),
      message: t('account.devices.signOut.message'),
      confirmLabel: t('account.signOut'),
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await api.delete(`/api/auth/sessions/${session.id}`);
      void queryClient.invalidateQueries({ queryKey: settingsKeys.sessions });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.audit });
      toast.success(t('account.devices.signedOut', { name }));
    } catch (error) {
      toast.error(describeError(error, t));
    }
  };

  // This device first, then the most recently used.
  const sorted = [...(sessions.data ?? [])].sort((a, b) => Number(b.current) - Number(a.current) || b.lastSeenAt - a.lastSeenAt);

  return (
    <List header={t('account.devices')} footer={t('account.devices.hint')}>
      {sessions.isPending ? (
        <LoadingRow label={t('common.loading')} />
      ) : !sessions.data ? (
        <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} retrying={sessions.isFetching} compact />
      ) : (
        sorted.map((session) => {
          const name = describeUserAgent(session.userAgent) ?? t('account.devices.unknown');
          const method = session.method === 'passkey' ? t('account.method.passkey') : session.method === 'setup' ? t('account.method.setup') : t('account.method.password');
          const details = [session.current ? t('account.devices.activeNow') : t('account.lastUsed', { when: t.relative(session.lastSeenAt) }), method, session.ip].filter(Boolean).join(' · ');
          return (
            <ListRow
              key={session.id}
              leading={deviceIcon(session.userAgent)}
              title={name}
              subtitle={details}
              trailing={session.current ? <Badge tone="accent">{t('account.devices.this')}</Badge> : undefined}
              {...(session.current
                ? {}
                : {
                    actions: [{ id: 'sign-out', label: t('account.signOut'), icon: <LogOut size={18} />, tone: 'danger' as const, onSelect: () => void signOutDevice(session, name) }],
                    actionsLabel: t('account.devices.actions', { name }),
                  })}
            />
          );
        })
      )}
    </List>
  );
}
