import { PASSWORD_MIN_LENGTH } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '@/data/api';
import { describeError } from '@/data/errors';
import { isApiError } from '@/data/http';
import { useUser } from '@/data/session';
import { passwordFailure } from '@/features/auth/messages';
import { checkNewPassword } from '@/features/auth/validation';
import { useT } from '@/i18n';
import { Banner, Button, Form, Sheet, TextField, toast } from '@/ui';
import { settingsKeys } from '../../api';

export function PasswordSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const user = useUser();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; confirmation?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);

  const close = () => {
    setCurrent('');
    setNext('');
    setConfirmation('');
    setErrors({});
    onClose();
  };

  const submit = async () => {
    if (busy) return;
    const found: typeof errors = {};
    if (current === '') found.current = t('account.password.currentMissing');
    const problem = checkNewPassword(next, t);
    if (problem) found.next = problem;
    else if (next === current) found.next = t('account.password.same');
    else if (confirmation !== next) found.confirmation = t('validation.password.mismatch');
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      await api.post('/api/auth/password', { currentPassword: current, newPassword: next }, { expectUnauthorized: true });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.sessions });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.audit });
      toast.success(t('account.password.changed'), { detail: t('account.password.changedDetail') });
      close();
    } catch (error) {
      if (isApiError(error) && error.code === 'invalid_credentials') setErrors({ current: t('account.password.currentWrong') });
      else if (isApiError(error) && error.code === 'weak_password') setErrors({ next: t('errors.weak_password') });
      else if (isApiError(error) && error.code === 'rate_limited') setErrors({ form: passwordFailure(error, t, '').text });
      else setErrors({ form: describeError(error, t) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={close}
      title={t('account.password.change')}
      dismissible={!busy}
      leading={
        <Button variant="plain" onClick={close} disabled={busy}>
          {t('common.cancel')}
        </Button>
      }
      trailing={
        <Button variant="plain" onClick={() => void submit()} loading={busy}>
          {t('common.save')}
        </Button>
      }
    >
      <Form className="settings-form" onSubmit={() => void submit()}>
        {errors.form && (
          <Banner tone="danger" role="alert">
            {errors.form}
          </Banner>
        )}
        <input type="text" name="username" autoComplete="username" value={user?.username ?? ''} readOnly hidden />
        <TextField
          label={t('account.password.current')}
          type="password"
          value={current}
          onChange={setCurrent}
          error={errors.current}
          autoComplete="current-password"
          disabled={busy}
          data-autofocus=""
        />
        <TextField
          label={t('account.password.new')}
          type="password"
          value={next}
          onChange={setNext}
          hint={t('auth.passwordHint', { count: PASSWORD_MIN_LENGTH })}
          error={errors.next}
          autoComplete="new-password"
          disabled={busy}
        />
        <TextField
          label={t('auth.confirmPassword')}
          type="password"
          value={confirmation}
          onChange={setConfirmation}
          error={errors.confirmation}
          autoComplete="new-password"
          disabled={busy}
        />
        <button type="submit" hidden />
      </Form>
    </Sheet>
  );
}
