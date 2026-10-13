import { type Role, type User, userSchema } from '@agent-studio/protocol';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UserPlus } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/data/api';
import { describeError } from '@/data/errors';
import { isApiError } from '@/data/http';
import { useUser } from '@/data/session';
import { type AccountErrors, checkAccountFields, checkNewPassword } from '@/features/auth/validation';
import { PASSWORD_MIN_LENGTH } from '@agent-studio/protocol';
import { type Translator, useT } from '@/i18n';
import { Avatar, Badge, Banner, Button, ConfirmDialog, DelayedSkeleton, ErrorState, Form, List, ListRow, SegmentedControl, Sheet, Skeleton, Switch, TextField, toast } from '@/ui';
import { settingsKeys, useUsers } from '../api';

/** For the page's row in the settings list. */
export function usePeopleSummary(): string | undefined {
  const t = useT();
  const users = useUsers();
  return users.data ? t.plural('people.count', users.data.length) : undefined;
}

const roleOptions = (t: Translator) => [
  { value: 'member' as const, label: t('people.role.member') },
  { value: 'owner' as const, label: t('people.role.owner') },
];

function AddPersonSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [errors, setErrors] = useState<AccountErrors>({});
  const [failure, setFailure] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post('/api/users', { username: username.trim(), password, role, ...(displayName.trim() ? { displayName: displayName.trim() } : {}) }, { schema: userSchema }),
    onSuccess: (user) => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.users });
      toast.success(t('people.added', { name: user.displayName || user.username }));
      setUsername('');
      setDisplayName('');
      setPassword('');
      setRole('member');
      onClose();
    },
    onError: (error) => {
      if (isApiError(error)) {
        if (error.code === 'reauth_cancelled') return;
        if (error.code === 'username_taken') return setErrors({ username: t('errors.username_taken') });
        if (error.code === 'weak_password') return setErrors({ password: t('errors.weak_password') });
      }
      setFailure(describeError(error, t));
    },
  });

  const submit = () => {
    if (create.isPending) return;
    const found = checkAccountFields({ username, password }, t);
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length === 0) create.mutate();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('people.add')}
      dismissible={!create.isPending}
      leading={
        <Button variant="plain" onClick={onClose} disabled={create.isPending}>
          {t('common.cancel')}
        </Button>
      }
      trailing={
        <Button variant="plain" onClick={submit} loading={create.isPending}>
          {t('common.add')}
        </Button>
      }
    >
      <Form className="settings-form" onSubmit={submit}>
        {failure && (
          <Banner tone="danger" role="alert">
            {failure}
          </Banner>
        )}
        <TextField
          label={t('auth.username')}
          value={username}
          onChange={setUsername}
          error={errors.username}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={create.isPending}
          data-autofocus=""
        />
        <TextField label={t('auth.displayName')} optional value={displayName} onChange={setDisplayName} autoComplete="off" maxLength={80} disabled={create.isPending} />
        <TextField
          label={t('people.initialPassword')}
          type="password"
          value={password}
          onChange={setPassword}
          hint={t('people.initialPassword.hint', { count: PASSWORD_MIN_LENGTH })}
          error={errors.password}
          autoComplete="new-password"
          disabled={create.isPending}
        />
        <div className="settings-form__group">
          <span className="settings-form__legend">{t('people.role')}</span>
          <SegmentedControl<Role> label={t('people.role')} value={role} onChange={setRole} options={roleOptions(t)} disabled={create.isPending} />
          <p className="ui-field__hint">{role === 'owner' ? t('people.role.ownerHint') : t('people.role.memberHint')}</p>
        </div>
        <button type="submit" hidden />
      </Form>
    </Sheet>
  );
}

function PersonSheet({ person, isSelf, onClose }: { person: User | null; isSelf: boolean; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [shown, setShown] = useState<User | null>(person);
  if (person && person !== shown) setShown(person);
  const [failure, setFailure] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const onError = (error: unknown) => {
    if (isApiError(error) && error.code === 'reauth_cancelled') return;
    if (isApiError(error) && error.code === 'weak_password') return setPasswordError(t('errors.weak_password'));
    setFailure(describeError(error, t));
  };

  const update = useMutation({
    mutationFn: (changes: { role?: Role; disabled?: boolean; password?: string }) => api.patch(`/api/users/${shown!.id}`, changes, { schema: userSchema }),
    onSuccess: (user, changes) => {
      setFailure(null);
      setShown(user);
      void queryClient.invalidateQueries({ queryKey: settingsKeys.users });
      if (changes.password !== undefined) {
        setNewPassword('');
        toast.success(t('people.passwordReset', { name: user.displayName || user.username }));
      }
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: () => api.delete(`/api/users/${shown!.id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: settingsKeys.users });
      toast.success(t('people.deleted', { name: shown!.displayName || shown!.username }));
      onClose();
    },
    onError,
  });

  if (!shown) return null;
  const busy = update.isPending || remove.isPending;
  const name = shown.displayName || shown.username;

  const resetPassword = () => {
    const problem = checkNewPassword(newPassword, t);
    setPasswordError(problem);
    if (!problem) update.mutate({ password: newPassword });
  };

  return (
    <>
      <Sheet open={person !== null} onClose={onClose} title={name} dismissible={!busy}>
        <div className="settings-form">
          <div className="settings-profile">
            <Avatar name={name} size={56} />
            <div style={{ minWidth: 0 }}>
              <p className="settings-profile__name">{name}</p>
              <div className="settings-profile__meta">
                <span>@{shown.username}</span>
                {isSelf && <Badge tone="accent">{t('people.you')}</Badge>}
                {shown.disabled && <Badge tone="warning">{t('people.disabled')}</Badge>}
              </div>
            </div>
          </div>

          {failure && (
            <Banner tone="danger" role="alert">
              {failure}
            </Banner>
          )}

          {isSelf ? (
            <Banner tone="neutral">{t('people.selfHint')}</Banner>
          ) : (
            <>
              <div className="settings-form__group">
                <span className="settings-form__legend">{t('people.role')}</span>
                <SegmentedControl<Role> label={t('people.role')} value={shown.role} onChange={(role) => update.mutate({ role })} options={roleOptions(t)} disabled={busy} />
                <p className="ui-field__hint">{shown.role === 'owner' ? t('people.role.ownerHint') : t('people.role.memberHint')}</p>
              </div>

              <List footer={t('people.enabled.hint')}>
                <ListRow title={t('people.enabled')} control={<Switch checked={!shown.disabled} onChange={(enabled) => update.mutate({ disabled: !enabled })} disabled={busy} />} />
              </List>

              <Form className="settings-form" onSubmit={resetPassword}>
                <TextField
                  label={t('people.newPassword')}
                  type="password"
                  value={newPassword}
                  onChange={(value) => {
                    setNewPassword(value);
                    setPasswordError(undefined);
                  }}
                  hint={t('people.newPassword.hint')}
                  error={passwordError}
                  autoComplete="new-password"
                  disabled={busy}
                />
                <Button type="submit" variant="tinted" disabled={newPassword === ''} loading={update.isPending && update.variables?.password !== undefined}>
                  {t('people.resetPassword')}
                </Button>
              </Form>

              <Button variant="danger" onClick={() => setConfirmingDelete(true)} disabled={busy}>
                {t('people.delete')}
              </Button>
            </>
          )}
        </div>
      </Sheet>
      <ConfirmDialog
        open={confirmingDelete}
        title={t('people.delete.title', { name })}
        message={t('people.delete.message')}
        confirmLabel={t('people.delete')}
        tone="danger"
        onCancel={() => setConfirmingDelete(false)}
        onConfirm={async () => {
          try {
            await remove.mutateAsync();
          } catch {
            /* reported by the mutation's onError */
          } finally {
            setConfirmingDelete(false);
          }
        }}
      />
    </>
  );
}

/** Owner only: who may sign in to this Studio, and as what. Changes ask for the owner's password again. */
export default function PeoplePage() {
  const t = useT();
  const me = useUser();
  const users = useUsers();
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  if (users.isPending) {
    return (
      <DelayedSkeleton label={t('common.loading')}>
        <List>
          {[0, 1].map((index) => (
            <ListRow key={index} leading={<Skeleton width={40} height={40} radius={20} />} title={<Skeleton width="40%" height={12} />} subtitle={<Skeleton width="25%" height={10} />} />
          ))}
        </List>
      </DelayedSkeleton>
    );
  }
  if (!users.data) return <ErrorState error={users.error} onRetry={() => void users.refetch()} retrying={users.isFetching} />;

  const open = users.data.find((user) => user.id === openId) ?? null;

  return (
    <>
      <List
        footer={t('people.hint')}
        headerAction={
          <Button variant="plain" size="sm" icon={<UserPlus size={16} aria-hidden="true" />} onClick={() => setAdding(true)}>
            {t('people.add')}
          </Button>
        }
        header={t.plural('people.count', users.data.length)}
      >
        {users.data.map((user) => (
          <ListRow
            key={user.id}
            leading={<Avatar name={user.displayName || user.username} />}
            title={user.displayName || user.username}
            subtitle={`@${user.username}`}
            trailing={
              <>
                {user.id === me?.id && <Badge tone="accent">{t('people.you')}</Badge>}
                {user.disabled && <Badge tone="warning">{t('people.disabled')}</Badge>}
                <Badge>{user.role === 'owner' ? t('people.role.owner') : t('people.role.member')}</Badge>
              </>
            }
            chevron
            onPress={() => setOpenId(user.id)}
          />
        ))}
      </List>
      <AddPersonSheet open={adding} onClose={() => setAdding(false)} />
      <PersonSheet person={open} isSelf={open?.id === me?.id} onClose={() => setOpenId(null)} />
    </>
  );
}
