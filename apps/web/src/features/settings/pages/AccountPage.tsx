import { useState } from 'react';
import { signOut, signOutEverywhere } from '@/data/auth';
import { describeError } from '@/data/errors';
import { useSession } from '@/data/session';
import { useT } from '@/i18n';
import { Avatar, Badge, ConfirmDialog, List, ListRow, toast } from '@/ui';
import { useLockStatus } from '../api';
import { DevicesSection } from './account/DevicesSection';
import { EventsSection } from './account/EventsSection';
import { PasskeysSection } from './account/PasskeysSection';
import { PasswordSheet } from './account/PasswordSheet';
import { TokensSection } from './account/TokensSection';

/** Who is signed in, how this account can be reached, and where it is signed in. */
export default function AccountPage() {
  const t = useT();
  const user = useSession((state) => state.user);
  const session = useSession((state) => state.session);
  const locks = useLockStatus();
  const [changingPassword, setChangingPassword] = useState(false);
  const [confirming, setConfirming] = useState<'here' | 'everywhere' | null>(null);

  if (!user) return null;
  const name = user.displayName || user.username;
  const now = Date.now();
  const signInLocked = (locks.data?.signInLockedUntil ?? 0) > now ? locks.data!.signInLockedUntil : null;
  const stepUpLocked = (locks.data?.stepUpLockedUntil ?? 0) > now ? locks.data!.stepUpLockedUntil : null;

  return (
    <>
      <div className="settings-profile">
        <Avatar name={name} size={64} />
        <div style={{ minWidth: 0 }}>
          <p className="settings-profile__name">{name}</p>
          <div className="settings-profile__meta">
            <span>@{user.username}</span>
            <Badge tone={user.role === 'owner' ? 'accent' : 'neutral'}>{user.role === 'owner' ? t('people.role.owner') : t('people.role.member')}</Badge>
          </div>
        </div>
      </div>

      <List header={t('account.security')} footer={signInLocked || stepUpLocked ? t('account.locks.hint') : undefined}>
        <ListRow
          title={t('account.locks.signIn')}
          subtitle={signInLocked ? t('account.locks.until', { when: t.date(signInLocked, 'dateTime') }) : undefined}
          trailing={<Badge tone={signInLocked ? 'danger' : 'positive'}>{signInLocked ? t('account.locks.locked') : t('account.locks.normal')}</Badge>}
        />
        {stepUpLocked && (
          <ListRow
            title={t('account.locks.stepUp')}
            subtitle={t('account.locks.until', { when: t.date(stepUpLocked, 'dateTime') })}
            trailing={<Badge tone="danger">{t('account.locks.locked')}</Badge>}
          />
        )}
        <ListRow title={t('account.password.change')} chevron onPress={() => setChangingPassword(true)} />
        {session && (
          <ListRow
            title={t('account.session')}
            subtitle={t('account.session.detail', { when: t.date(session.authenticatedAt, 'dateTime'), expires: t.date(session.expiresAt, 'date') })}
            value={session.method === 'passkey' ? t('account.method.passkey') : session.method === 'setup' ? t('account.method.setup') : t('account.method.password')}
          />
        )}
      </List>

      <PasskeysSection />
      <DevicesSection />
      <TokensSection />
      <EventsSection />

      <List footer={t('account.signOutEverywhere.hint')}>
        <ListRow title={t('account.signOut')} tone="danger" onPress={() => setConfirming('here')} />
        <ListRow title={t('account.signOutEverywhere')} tone="danger" onPress={() => setConfirming('everywhere')} />
      </List>

      <PasswordSheet open={changingPassword} onClose={() => setChangingPassword(false)} />
      <ConfirmDialog
        open={confirming === 'here'}
        title={t('account.signOut.title')}
        message={t('account.signOut.message')}
        confirmLabel={t('account.signOut')}
        tone="danger"
        onCancel={() => setConfirming(null)}
        onConfirm={async () => {
          await signOut();
        }}
      />
      <ConfirmDialog
        open={confirming === 'everywhere'}
        title={t('account.signOutEverywhere.title')}
        message={t('account.signOutEverywhere.message')}
        confirmLabel={t('account.signOutEverywhere')}
        tone="danger"
        onCancel={() => setConfirming(null)}
        onConfirm={async () => {
          try {
            await signOutEverywhere();
            toast.success(t('account.signOutEverywhere.done'));
          } catch (error) {
            setConfirming(null);
            toast.error(describeError(error, t));
          }
        }}
      />
    </>
  );
}
