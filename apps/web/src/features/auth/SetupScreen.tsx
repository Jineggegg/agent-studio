import { PASSWORD_MIN_LENGTH } from '@agent-studio/protocol';
import { useEffect, useState } from 'react';
import { setUp } from '@/data/auth';
import { describeError } from '@/data/errors';
import { isApiError } from '@/data/http';
import { useT } from '@/i18n';
import { announceFirstPaint } from '@/shell/launch';
import { useDocumentTitle } from '@/shell/title';
import { Banner, Button, Form, LogoMark, TextField } from '@/ui';
import { waitDescription } from './messages';
import { type AccountErrors, checkAccountFields } from './validation';
import './auth.css';

/**
 * First run: create the owner account. The setup token — printed by the
 * server on its console — proves that whoever fills this in controls the machine.
 */
export default function SetupScreen() {
  const t = useT();
  const [setupToken, setSetupToken] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<AccountErrors & { setupToken?: string }>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useDocumentTitle(t('auth.setup.title'));
  useEffect(() => announceFirstPaint(), []);

  const submit = async () => {
    if (busy) return;
    const found: AccountErrors & { setupToken?: string } = checkAccountFields({ username, password, confirmation }, t);
    if (setupToken.trim() === '') found.setupToken = t('auth.setup.tokenMissing');
    setErrors(found);
    setFailure(null);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      await setUp({
        setupToken: setupToken.trim(),
        username: username.trim(),
        password,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
    } catch (error) {
      setBusy(false);
      if (isApiError(error)) {
        if (error.code === 'invalid_setup_token') return setErrors({ setupToken: t('errors.invalid_setup_token') });
        if (error.code === 'weak_password') return setErrors({ password: t('errors.weak_password') });
        if (error.code === 'rate_limited' && error.retryAfterSeconds) return setFailure(t('auth.locked', waitDescription(error.retryAfterSeconds, t)));
      }
      setFailure(describeError(error, t));
    }
  };

  return (
    <main className="auth u-scroll">
      <div className="auth__card">
        <div className="auth__head">
          <LogoMark size={52} plated />
          <h1 className="auth__title">{t('auth.setup.title')}</h1>
          <p className="auth__lead">{t('auth.setup.lead')}</p>
        </div>

        {failure && (
          <Banner tone="danger" role="alert">
            {failure}
          </Banner>
        )}

        <Form className="auth__form" onSubmit={() => void submit()} aria-label={t('auth.setup.title')}>
          <TextField
            label={t('auth.setup.token')}
            name="setup-token"
            value={setupToken}
            onChange={setSetupToken}
            hint={t('auth.setup.tokenHint')}
            error={errors.setupToken}
            secret
            mono
            autoComplete="off"
            enterKeyHint="next"
            disabled={busy}
          />
          <TextField
            label={t('auth.username')}
            name="username"
            value={username}
            onChange={setUsername}
            error={errors.username}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="next"
            disabled={busy}
          />
          <TextField
            label={t('auth.displayName')}
            name="display-name"
            optional
            value={displayName}
            onChange={setDisplayName}
            autoComplete="name"
            enterKeyHint="next"
            maxLength={80}
            disabled={busy}
          />
          <TextField
            label={t('auth.password')}
            name="new-password"
            type="password"
            value={password}
            onChange={setPassword}
            hint={t('auth.passwordHint', { count: PASSWORD_MIN_LENGTH })}
            error={errors.password}
            autoComplete="new-password"
            enterKeyHint="next"
            disabled={busy}
          />
          <TextField
            label={t('auth.confirmPassword')}
            name="confirm-password"
            type="password"
            value={confirmation}
            onChange={setConfirmation}
            error={errors.confirmation}
            autoComplete="new-password"
            enterKeyHint="go"
            disabled={busy}
          />
          <Button type="submit" variant="primary" size="lg" block loading={busy} loadingLabel={t('auth.setup.working')}>
            {t('auth.setup.action')}
          </Button>
        </Form>

        <p className="auth__foot">{t('auth.setup.foot')}</p>
      </div>
    </main>
  );
}
