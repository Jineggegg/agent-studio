import { Fingerprint } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { describeError } from '@/data/errors';
import { isApiError } from '@/data/http';
import { applyAuthState, useSession } from '@/data/session';
import { beginSessionFromState } from '@/data/auth';
import { useT } from '@/i18n';
import { usePageVisible } from '@/platform/media';
import type { SignInMethodProps } from '@/registry';
import { Button } from '@/ui';
import { OPTIONS_FRESH_MS, fetchLoginOptions, passkeyFailure, passkeysSupportedHere, signInWithPasskey } from './passkeys';

type Options = Awaited<ReturnType<typeof fetchLoginOptions>>;

/**
 * "Sign in with a passkey". Rendered only where it can work: the server says
 * passkeys are available at this address and the browser supports them.
 */
export function PasskeySignIn({ disabled, onBusyChange, onMessage }: SignInMethodProps) {
  const t = useT();
  const available = useSession((state) => state.passkeysAvailable);
  const visible = usePageVisible();
  const [supported] = useState(passkeysSupportedHere);
  const [busy, setBusy] = useState(false);
  const prepared = useRef<{ options: Options; at: number } | null>(null);
  const usable = available && supported;

  // Keep a fresh challenge at hand, so the tap can open the system sheet with no request in between.
  useEffect(() => {
    if (!usable || !visible || busy) return;
    const controller = new AbortController();
    const prepare = () => {
      fetchLoginOptions(controller.signal).then(
        (options) => {
          prepared.current = { options, at: Date.now() };
        },
        () => {
          prepared.current = null;
        },
      );
    };
    prepare();
    const timer = window.setInterval(prepare, OPTIONS_FRESH_MS - 5_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [usable, visible, busy]);

  if (!usable) return null;

  const start = async () => {
    if (busy || disabled) return;
    setBusy(true);
    onBusyChange(true);
    onMessage(null);
    try {
      const ready = prepared.current;
      prepared.current = null;
      const options = ready && Date.now() - ready.at < OPTIONS_FRESH_MS ? ready.options : await fetchLoginOptions();
      const state = await signInWithPasskey(options);
      applyAuthState(state);
      beginSessionFromState(state);
    } catch (error) {
      const failure = passkeyFailure(error);
      if (failure === 'cancelled') onMessage({ tone: 'neutral', text: t('auth.passkey.cancelled') });
      else if (failure === 'unavailable') onMessage({ tone: 'danger', text: t('errors.passkeys_unavailable') });
      else if (failure) onMessage({ tone: 'danger', text: t('auth.passkey.failed') });
      else if (isApiError(error) && error.code === 'invalid_credentials') onMessage({ tone: 'danger', text: t('auth.passkey.refused') });
      else onMessage({ tone: 'danger', text: describeError(error, t) });
      setBusy(false);
      onBusyChange(false);
    }
  };

  return (
    <Button variant="neutral" size="lg" block icon={<Fingerprint size={20} aria-hidden="true" />} loading={busy} loadingLabel={t('auth.passkey.working')} disabled={disabled && !busy} onClick={() => void start()}>
      {t('auth.passkey.action')}
    </Button>
  );
}
