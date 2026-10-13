import { type ApiToken, type CreatedApiToken, type TokenScope, createdApiTokenSchema } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/data/api';
import { describeError } from '@/data/errors';
import { isApiError } from '@/data/http';
import { useIsOwner } from '@/data/session';
import { type MessageKey, useT } from '@/i18n';
import { copyText } from '@/platform/clipboard';
import { Badge, Banner, Button, Checkbox, ErrorState, Form, IconButton, List, ListRow, LoadingRow, Select, Sheet, TextField, confirm, toast } from '@/ui';
import { settingsKeys, useApiTokens } from '../../api';

type Expiry = 'never' | '7' | '30' | '90' | '365';
const SCOPE_LABEL: Record<TokenScope, MessageKey> = { read: 'account.tokens.scope.read', write: 'account.tokens.scope.write', admin: 'account.tokens.scope.admin' };
const SCOPE_HINT: Record<TokenScope, MessageKey> = { read: 'account.tokens.scope.readHint', write: 'account.tokens.scope.writeHint', admin: 'account.tokens.scope.adminHint' };

function NewTokenSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const isOwner = useIsOwner();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Record<TokenScope, boolean>>({ read: true, write: false, admin: false });
  const [expiry, setExpiry] = useState<Expiry>('90');
  const [errors, setErrors] = useState<{ name?: string; scopes?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const available: TokenScope[] = isOwner ? ['read', 'write', 'admin'] : ['read', 'write'];

  const close = () => {
    // The secret is gone for good the moment this sheet closes.
    setCreated(null);
    setCopied(false);
    setName('');
    setScopes({ read: true, write: false, admin: false });
    setExpiry('90');
    setErrors({});
    onClose();
  };

  const submit = async () => {
    if (busy) return;
    const chosen = available.filter((scope) => scopes[scope]);
    const found: typeof errors = {};
    if (name.trim() === '') found.name = t('account.tokens.nameMissing');
    if (chosen.length === 0) found.scopes = t('account.tokens.scopesMissing');
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setBusy(true);
    try {
      const result = await api.post(
        '/api/auth/tokens',
        { name: name.trim(), scopes: chosen, ...(expiry === 'never' ? {} : { expiresInDays: Number(expiry) }) },
        { schema: createdApiTokenSchema },
      );
      setCreated(result);
      void queryClient.invalidateQueries({ queryKey: settingsKeys.tokens });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.audit });
    } catch (error) {
      if (!(isApiError(error) && error.code === 'reauth_cancelled')) setErrors({ form: describeError(error, t) });
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <Sheet
        open={open}
        onClose={close}
        title={t('account.tokens.created.title')}
        footer={
          <Button variant="primary" onClick={close}>
            {t('account.tokens.created.done')}
          </Button>
        }
      >
        <div className="secret-once">
          <Banner tone="warning" title={t('account.tokens.created.once')}>
            {t('account.tokens.created.onceDetail')}
          </Banner>
          <div className="secret-once__value">
            <code data-testid="token-secret">{created.token}</code>
            <IconButton
              label={copied ? t('common.copied') : t('account.tokens.copy')}
              icon={copied ? <Check size={20} /> : <Copy size={20} />}
              variant="filled"
              tone={copied ? 'accent' : 'default'}
              onClick={() => void copyText(created.token).then((ok) => (ok ? setCopied(true) : toast.error(t('account.tokens.copyFailed'))))}
            />
          </div>
          <p className="text-footnote text-secondary" aria-live="polite">
            {copied ? t('common.copied') : t('account.tokens.created.usage', { name: created.record.name })}
          </p>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title={t('account.tokens.new')}
      dismissible={!busy}
      leading={
        <Button variant="plain" onClick={close} disabled={busy}>
          {t('common.cancel')}
        </Button>
      }
      trailing={
        <Button variant="plain" onClick={() => void submit()} loading={busy}>
          {t('common.create')}
        </Button>
      }
    >
      <Form className="settings-form" onSubmit={() => void submit()}>
        {errors.form && (
          <Banner tone="danger" role="alert">
            {errors.form}
          </Banner>
        )}
        <TextField
          label={t('account.tokens.name')}
          value={name}
          onChange={setName}
          hint={t('account.tokens.nameHint')}
          error={errors.name}
          maxLength={80}
          autoComplete="off"
          disabled={busy}
          data-autofocus=""
        />
        <fieldset className="settings-form__group" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <legend className="settings-form__legend" style={{ padding: 0 }}>
            {t('account.tokens.scopes')}
          </legend>
          {available.map((scope) => (
            <Checkbox
              key={scope}
              checked={scopes[scope]}
              onChange={(checked) => setScopes((current) => ({ ...current, [scope]: checked }))}
              label={t(SCOPE_LABEL[scope])}
              hint={t(SCOPE_HINT[scope])}
              disabled={busy}
            />
          ))}
          {errors.scopes && (
            <p className="ui-field__error" role="alert">
              {errors.scopes}
            </p>
          )}
        </fieldset>
        <div className="settings-form__group">
          <span className="settings-form__legend">{t('account.tokens.expiry')}</span>
          <Select<Expiry>
            label={t('account.tokens.expiry')}
            value={expiry}
            onChange={setExpiry}
            block
            disabled={busy}
            options={[
              { value: '7', label: t.plural('account.tokens.expiry.days', 7) },
              { value: '30', label: t.plural('account.tokens.expiry.days', 30) },
              { value: '90', label: t.plural('account.tokens.expiry.days', 90) },
              { value: '365', label: t.plural('account.tokens.expiry.days', 365) },
              { value: 'never', label: t('account.tokens.expiry.never'), hint: t('account.tokens.expiry.neverHint') },
            ]}
          />
        </div>
        <button type="submit" hidden />
      </Form>
    </Sheet>
  );
}

/** API tokens for scripts: create (the secret is shown once), list, revoke. */
export function TokensSection() {
  const t = useT();
  const queryClient = useQueryClient();
  const tokens = useApiTokens();
  const [creating, setCreating] = useState(false);

  const revoke = async (token: ApiToken) => {
    const confirmed = await confirm({
      title: t('account.tokens.revoke.title', { name: token.name }),
      message: t('account.tokens.revoke.message'),
      confirmLabel: t('account.tokens.revoke'),
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      await api.delete(`/api/auth/tokens/${token.id}`);
      void queryClient.invalidateQueries({ queryKey: settingsKeys.tokens });
      void queryClient.invalidateQueries({ queryKey: settingsKeys.audit });
      toast.success(t('account.tokens.revoked', { name: token.name }));
    } catch (error) {
      toast.error(describeError(error, t));
    }
  };

  return (
    <>
      <List header={t('account.tokens')} footer={t('account.tokens.hint')}>
        {tokens.isPending ? (
          <LoadingRow label={t('common.loading')} />
        ) : !tokens.data ? (
          <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} retrying={tokens.isFetching} compact />
        ) : (
          <>
            {tokens.data.map((token) => {
              const expired = token.expiresAt !== null && token.expiresAt <= Date.now();
              const expiry = token.expiresAt === null ? t('account.tokens.noExpiry') : expired ? t('account.tokens.expired') : t('account.tokens.expires', { when: t.date(token.expiresAt, 'date') });
              const used = token.lastUsedAt ? t('account.lastUsed', { when: t.relative(token.lastUsedAt) }) : t('account.neverUsed');
              return (
                <ListRow
                  key={token.id}
                  leading={<KeyRound size={20} />}
                  title={token.name}
                  subtitle={`${token.scopes.map((scope) => t(SCOPE_LABEL[scope])).join(', ')} · ${used} · ${expiry}`}
                  trailing={expired ? <Badge tone="warning">{t('account.tokens.expired')}</Badge> : undefined}
                  actions={[{ id: 'revoke', label: t('account.tokens.revoke'), icon: <Trash2 size={18} />, tone: 'danger', onSelect: () => void revoke(token) }]}
                  actionsLabel={t('account.tokens.actions', { name: token.name })}
                />
              );
            })}
            {tokens.data.length === 0 && <ListRow title={t('account.tokens.none')} subtitle={t('account.tokens.noneHint')} />}
            <ListRow title={t('account.tokens.new')} tone="accent" onPress={() => setCreating(true)} />
          </>
        )}
      </List>
      <NewTokenSheet open={creating} onClose={() => setCreating(false)} />
    </>
  );
}
