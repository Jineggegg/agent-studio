import { useEffect, useState } from 'react';
import { confirmIdentity } from '@/data/auth';
import { settleReauth, useReauth } from '@/data/reauth';
import { useUser } from '@/data/session';
import { useT } from '@/i18n';
import { Banner, Button, Form, Sheet, TextField } from '@/ui';
import { passwordFailure } from './messages';
import './auth.css';

/**
 * "Confirm it's you." Opens whenever the server asks for recent
 * authentication (403 reauth_required); the HTTP client then repeats the
 * request that was refused. Mounted once by the app.
 */
export function ReauthDialog() {
  const t = useT();
  const pending = useReauth((state) => state.pending);
  const user = useUser();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retryAt, setRetryAt] = useState<number | null>(null);

  useEffect(() => {
    if (!pending) return;
    setPassword('');
    setError(null);
    setBusy(false);
  }, [pending]);

  useEffect(() => {
    if (retryAt === null) return;
    const timer = window.setTimeout(() => setRetryAt(null), Math.max(0, retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [retryAt]);

  const submit = async () => {
    if (busy || retryAt !== null) return;
    if (password === '') {
      setError(t('auth.reauth.missing'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await confirmIdentity(password);
      settleReauth(true);
    } catch (failure) {
      const { text, retryAt: wait } = passwordFailure(failure, t, t('auth.reauth.wrong'));
      setError(text);
      setRetryAt(wait);
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={pending}
      onClose={() => settleReauth(false)}
      title={t('auth.reauth.title')}
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <Button variant="neutral" onClick={() => settleReauth(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={retryAt !== null}>
            {t('auth.reauth.action')}
          </Button>
        </>
      }
    >
      <Form className="reauth" onSubmit={() => void submit()}>
        <p className="reauth__lead">{t('auth.reauth.lead')}</p>
        {/* Lets a password manager match the right account. */}
        <input type="text" name="username" autoComplete="username" value={user?.username ?? ''} readOnly hidden />
        <TextField
          label={t('auth.password')}
          name="password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          enterKeyHint="go"
          disabled={busy}
          data-autofocus=""
        />
        {error && (
          <Banner tone="danger" role="alert">
            {error}
          </Banner>
        )}
        {/* With two text fields and no submit button inside the form, a browser does nothing on Enter; this makes Enter submit. */}
        <button type="submit" hidden />
      </Form>
    </Sheet>
  );
}
