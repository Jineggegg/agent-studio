import { useEffect, useState } from 'react';
import { signIn } from '@/data/auth';
import { useSession } from '@/data/session';
import { useT } from '@/i18n';
import { signInMethods } from '@/registry';
import { announceFirstPaint } from '@/shell/launch';
import { useDocumentTitle } from '@/shell/title';
import { Banner, Button, Form, LogoMark, TextField } from '@/ui';
import { passwordFailure } from './messages';
import './auth.css';

type Message = { tone: 'danger' | 'neutral'; text: string };

/**
 * Sign in with a username and password. One message region carries every
 * outcome; a wrong username and a wrong password are indistinguishable.
 */
export default function LoginScreen() {
  const t = useT();
  const endReason = useSession((state) => state.endReason);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [methodBusy, setMethodBusy] = useState(false);
  /** Password sign-in is throttled until this moment. */
  const [retryAt, setRetryAt] = useState<number | null>(null);

  useDocumentTitle(t('auth.signIn.title'));
  useEffect(() => announceFirstPaint(), []);

  useEffect(() => {
    if (retryAt === null) return;
    const timer = window.setTimeout(() => setRetryAt(null), Math.max(0, retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [retryAt]);

  const submit = async () => {
    if (busy || methodBusy) return;
    if (username.trim() === '' || password === '') {
      setMessage({ tone: 'danger', text: t('auth.signIn.missing') });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await signIn({ username: username.trim(), password });
      // The app shell notices the session and moves on; the form stays as it is meanwhile.
    } catch (error) {
      const failure = passwordFailure(error, t, t('auth.signIn.invalid'));
      setMessage({ tone: 'danger', text: failure.text });
      setRetryAt(failure.retryAt);
      setBusy(false);
    }
  };

  const methods = signInMethods();

  return (
    <main className="auth u-scroll">
      <div className="auth__card">
        <div className="auth__head">
          <LogoMark size={52} plated />
          <h1 className="auth__title">{t('auth.signIn.title')}</h1>
          <p className="auth__lead">{t('auth.signIn.lead')}</p>
        </div>

        {endReason === 'expired' && !message && <Banner tone="info">{t('auth.signIn.expired')}</Banner>}
        {message && (
          <Banner tone={message.tone === 'danger' ? 'danger' : 'neutral'} role="alert">
            {message.text}
          </Banner>
        )}

        <Form className="auth__form" onSubmit={() => void submit()} aria-label={t('auth.signIn.title')}>
          <TextField
            label={t('auth.username')}
            name="username"
            value={username}
            onChange={setUsername}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            disabled={busy}
          />
          <TextField
            label={t('auth.password')}
            name="password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
            enterKeyHint="go"
            disabled={busy}
          />
          <Button type="submit" variant="primary" size="lg" block loading={busy} loadingLabel={t('auth.signIn.working')} disabled={methodBusy || retryAt !== null}>
            {t('auth.signIn.action')}
          </Button>
        </Form>

        <div className="auth__methods" data-divider={t('auth.signIn.or')}>
          {methods.map(({ id, Component }) => (
            <Component key={id} disabled={busy || methodBusy} onBusyChange={setMethodBusy} onMessage={setMessage} />
          ))}
        </div>

        <p className="auth__foot">{t('auth.signIn.foot')}</p>
      </div>
    </main>
  );
}
