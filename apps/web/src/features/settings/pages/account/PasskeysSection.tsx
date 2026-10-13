import type { Passkey } from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fingerprint, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { describeError } from '@/data/errors';
import { isApiError } from '@/data/http';
import { OPTIONS_FRESH_MS, fetchRegistrationOptions, listPasskeys, passkeyFailure, passkeysSupportedHere, registerPasskey, removePasskey } from '@/features/auth/passkeys';
import { useT } from '@/i18n';
import { Badge, Banner, Button, ErrorState, Form, List, ListRow, LoadingRow, Sheet, TextField, confirm, toast } from '@/ui';
import { settingsKeys } from '../../api';

type Options = Awaited<ReturnType<typeof fetchRegistrationOptions>>;

function AddPasskeySheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'danger' | 'neutral'; text: string } | null>(null);
  const [ready, setReady] = useState(false);
  const prepared = useRef<{ options: Options; at: number } | null>(null);

  // The challenge is fetched as soon as the sheet opens (this is where the server may ask for the
  // password again), so that "Create passkey" can open the system sheet straight from the tap.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setMessage(null);
    setReady(false);
    prepared.current = null;
    const prepare = () =>
      fetchRegistrationOptions().then(
        (options) => {
          if (cancelled) return;
          prepared.current = { options, at: Date.now() };
          setReady(true);
        },
        (error: unknown) => {
          if (cancelled) return;
          if (isApiError(error) && error.code === 'reauth_cancelled') return onClose();
          setMessage({ tone: 'danger', text: describeError(error, t) });
        },
      );
    void prepare();
    const timer = window.setInterval(() => void prepare(), OPTIONS_FRESH_MS - 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // Runs once per opening; the translator and close callback of that moment are the right ones.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const held = prepared.current;
      const options = held && Date.now() - held.at < OPTIONS_FRESH_MS ? held.options : await fetchRegistrationOptions();
      prepared.current = null;
      const passkey = await registerPasskey(options, name.trim() || undefined);
      void queryClient.invalidateQueries({ queryKey: settingsKeys.passkeys });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.audit });
      toast.success(t('account.passkeys.added', { name: passkey.name }));
      setName('');
      onClose();
    } catch (error) {
      const failure = passkeyFailure(error);
      if (failure === 'cancelled') setMessage({ tone: 'neutral', text: t('auth.passkey.cancelled') });
      else if (failure === 'exists') setMessage({ tone: 'danger', text: t('errors.passkey_exists') });
      else if (failure === 'unavailable') setMessage({ tone: 'danger', text: t('errors.passkeys_unavailable') });
      else if (failure) setMessage({ tone: 'danger', text: t('auth.passkey.failed') });
      else if (!(isApiError(error) && error.code === 'reauth_cancelled')) setMessage({ tone: 'danger', text: describeError(error, t) });
      // A used or refused challenge is gone: fetch a new one for the next try.
      setReady(false);
      fetchRegistrationOptions().then(
        (options) => {
          prepared.current = { options, at: Date.now() };
          setReady(true);
        },
        () => undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('account.passkeys.add')}
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <Button variant="neutral" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon={<Fingerprint size={18} aria-hidden="true" />} onClick={() => void create()} loading={busy} disabled={!ready}>
            {t('account.passkeys.create')}
          </Button>
        </>
      }
    >
      <Form className="settings-form" onSubmit={() => void create()}>
        <p className="text-secondary">{t('account.passkeys.addLead', { host: window.location.hostname })}</p>
        <TextField label={t('account.passkeys.name')} optional value={name} onChange={setName} hint={t('account.passkeys.nameHint')} maxLength={80} disabled={busy} autoComplete="off" />
        {message && (
          <Banner tone={message.tone === 'danger' ? 'danger' : 'neutral'} role="alert">
            {message.text}
          </Banner>
        )}
      </Form>
    </Sheet>
  );
}

/** Passkeys of the account: which address each belongs to, and adding or removing one. */
export function PasskeysSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const passkeys = useQuery({ queryKey: settingsKeys.passkeys, queryFn: listPasskeys });
  const [adding, setAdding] = useState(false);
  const [supported] = useState(passkeysSupportedHere);

  const remove = async (passkey: Passkey) => {
    const confirmed = await confirm({
      title: t('account.passkeys.remove.title', { name: passkey.name }),
      message: t('account.passkeys.remove.message', { host: passkey.hostname }),
      confirmLabel: t('common.remove'),
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await removePasskey(passkey.id);
      void queryClient.invalidateQueries({ queryKey: settingsKeys.passkeys });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.audit });
      toast.success(t('account.passkeys.removed'));
    } catch (error) {
      if (!(isApiError(error) && error.code === 'reauth_cancelled')) toast.error(describeError(error, t));
    }
  };

  const data = passkeys.data;
  // The passkeys usable at this address first, then the others by address.
  const sorted = [...(data?.passkeys ?? [])].sort((a, b) => Number(b.usableHere) - Number(a.usableHere) || a.hostname.localeCompare(b.hostname));
  const canAdd = !!data?.available && supported;

  return (
    <>
      <List
        header={t('account.passkeys')}
        footer={
          !data
            ? undefined
            : !data.available
              ? t('account.passkeys.unavailableHere')
              : !supported
                ? t('account.passkeys.unsupported')
                : t('account.passkeys.hint', { host: window.location.hostname })
        }
      >
        {passkeys.isPending ? (
          <LoadingRow label={t('common.loading')} />
        ) : !data ? (
          <ErrorState error={passkeys.error} onRetry={() => void passkeys.refetch()} retrying={passkeys.isFetching} compact />
        ) : (
          <>
            {sorted.map((passkey) => (
              <ListRow
                key={passkey.id}
                leading={<Fingerprint size={20} />}
                title={passkey.name}
                subtitle={`${passkey.hostname} · ${passkey.lastUsedAt ? t('account.lastUsed', { when: t.relative(passkey.lastUsedAt) }) : t('account.neverUsed')}`}
                trailing={
                  <>
                    {passkey.usableHere && <Badge tone="accent">{t('account.passkeys.here')}</Badge>}
                    {passkey.syncedAcrossDevices && <Badge>{t('account.passkeys.synced')}</Badge>}
                  </>
                }
                actions={[{ id: 'remove', label: t('common.remove'), icon: <Trash2 size={18} />, tone: 'danger', onSelect: () => void remove(passkey) }]}
                actionsLabel={t('account.passkeys.actions', { name: passkey.name })}
              />
            ))}
            {sorted.length === 0 && <ListRow title={t('account.passkeys.none')} subtitle={t('account.passkeys.noneHint')} />}
            {canAdd && <ListRow title={t('account.passkeys.add')} tone="accent" onPress={() => setAdding(true)} />}
          </>
        )}
      </List>
      <AddPasskeySheet open={adding} onClose={() => setAdding(false)} />
    </>
  );
}
