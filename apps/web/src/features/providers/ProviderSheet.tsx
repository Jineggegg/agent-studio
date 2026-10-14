import type { Provider, ProviderPreset, ProviderVerifyResult } from '@agent-studio/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, ExternalLink, Eye, EyeOff, KeyRound, PlugZap, Search, ShieldAlert, Trash2 } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { isApiError } from '@/data/api';
import { describeError } from '@/data/errors';
import { ProviderSpend } from '@/features/usage/ProviderSpend';
import { useT } from '@/i18n';
import { useUnsavedWork } from '@/pwa/update';
import { Badge, Banner, Button, Form, IconButton, Select, Sheet, Spinner, Switch, TextField, confirm, toast } from '@/ui';
import { Catalogue } from './Catalogue';
import { providerKeys, providersApi } from './api';
import { keyOutcome, keyPlaceholder, keyProblemKey, keyStatus, keyWarning } from './keyField';
import { type ProviderDraft, checkText, createRequest, draftFromPreset, draftFromProvider, hostOf, updateRequest } from './model';

/**
 * The API key: written here, never read back. It starts empty whatever is
 * saved; blank keeps the saved key. Shown masked, and kept out of password
 * managers (it is not a password for this site).
 */
export function KeyField({ value, onChange, placeholder, disabled, error, hint }: { value: string; onChange: (value: string) => void; placeholder: string; disabled?: boolean; error?: string | null; hint?: ReactNode }) {
  const t = useT();
  const [revealed, setRevealed] = useState(false);
  // Where the browser cannot mask a plain field, a password field (with its own show/hide) is the fallback.
  const canMask = typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('-webkit-text-security', 'disc');
  return (
    <div className="prv-key" data-masked={revealed || !canMask ? undefined : ''}>
      <TextField
        type={canMask ? 'text' : 'password'}
        label={t('providers.key.label')}
        // The section it sits in is headed "API key" already.
        hideLabel
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        error={error}
        hint={hint}
        secret
        mono
        autoComplete="off"
        data-lpignore="true"
        data-1p-ignore=""
        data-bwignore=""
        data-form-type="other"
        trailing={
          canMask && value !== '' ? (
            <IconButton label={revealed ? t('providers.key.hide') : t('providers.key.show')} icon={revealed ? <EyeOff size={19} /> : <Eye size={19} />} tone="secondary" aria-pressed={revealed} onClick={() => setRevealed(!revealed)} />
          ) : undefined
        }
      />
    </div>
  );
}

/** A notice or refusal appears at the top of a form that may be scrolled down: bring it into view (a stable ref, so once per message). */
const reveal = (element: HTMLElement | null) => element?.scrollIntoView?.({ block: 'nearest' });

function Section({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  const id = useId();
  return (
    <section className="prv-section" aria-labelledby={id}>
      <h3 id={id} className="prv-section__title">
        {title}
      </h3>
      {children}
      {footer && <p className="prv-note">{footer}</p>}
    </section>
  );
}

export interface ProviderSheetProps {
  open: boolean;
  /** Null to add one. */
  provider: Provider | null;
  presets: readonly ProviderPreset[];
  onClose: () => void;
}

/** Adding or managing one provider. Each opening starts from the server's record; the key field always starts empty. */
export function ProviderSheet({ open, provider, presets, onClose }: ProviderSheetProps) {
  const [shown, setShown] = useState<{ opening: number; provider: Provider | null } | null>(null);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setShown({ opening: (shown?.opening ?? 0) + 1, provider });
  }
  if (!shown) return null;
  return <ProviderForm key={shown.opening} open={open} initial={shown.provider} presets={presets} onClose={onClose} />;
}

function ProviderForm({ open, initial, presets, onClose }: { open: boolean; initial: Provider | null; presets: readonly ProviderPreset[]; onClose: () => void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [provider, setProvider] = useState<Provider | null>(initial);
  const [preset, setPreset] = useState<string | null>(initial ? null : (presets[0]?.id ?? null));
  const [draft, setDraft] = useState<ProviderDraft>(() => (initial ? draftFromProvider(initial) : draftFromPreset(presets[0] ?? null)));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [keyProblem, setKeyProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verify, setVerify] = useState<ProviderVerifyResult | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [removing, setRemoving] = useState(false);
  const set = (patch: Partial<ProviderDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setNotice(null);
  };

  const editing = provider !== null;
  const changes = provider ? updateRequest(provider, draft) : null;
  const dirty = provider ? changes !== null : draft.name.trim() !== '' || draft.baseUrl.trim() !== '' || draft.key !== '';
  useUnsavedWork(open && dirty);
  const status = keyStatus(provider);
  const warning = keyWarning({ originalBaseUrl: provider?.settings?.baseUrl ?? null, baseUrl: draft.baseUrl, keyConfigured: status === 'configured' || status === 'unreadable', typed: draft.key });
  const catalogueDirty = provider ? JSON.stringify(draft.models) !== JSON.stringify(provider.settings?.catalogue ?? []) : false;
  const presetInfo = presets.find((entry) => entry.id === (preset ?? draft.preset));

  const refresh = (next: Provider) => {
    setProvider(next);
    setDraft(draftFromProvider(next));
    // From now on the server's record of the last check counts: it forgets a check when the address or key changes.
    setVerify(null);
    void queryClient.invalidateQueries({ queryKey: providerKeys.all });
    void queryClient.invalidateQueries({ queryKey: ['workbench', 'agents'] });
  };

  const fail = (error: unknown) => {
    if (isApiError(error) && error.code === 'reauth_cancelled') {
      setProblem(t('providers.reauthCancelled'));
      return;
    }
    if (isApiError(error) && error.code === 'invalid_api_key') {
      setKeyProblem(t(keyProblemKey(error.details)));
      return;
    }
    setProblem(describeError(error, t));
  };

  const save = async () => {
    if (saving) return;
    setProblem(null);
    setKeyProblem(null);
    setNotice(null);
    if (draft.name.trim() === '' || draft.baseUrl.trim() === '') {
      setProblem(t('providers.form.missing'));
      return;
    }
    setSaving(true);
    try {
      if (!provider) {
        const created = await providersApi.create(createRequest(draft));
        refresh(created);
        setNotice({ tone: 'success', text: t('providers.form.created', { name: created.name }) });
        toast.success(t('providers.form.created', { name: created.name }));
      } else if (changes) {
        const sentKey = changes.apiKey !== undefined;
        const answer = await providersApi.update(provider.id, changes);
        refresh(answer.provider);
        const outcome = keyOutcome(answer, sentKey);
        setNotice(
          outcome === 'key-cleared'
            ? { tone: 'warning', text: t('providers.key.cleared') }
            : outcome === 'key-saved'
              ? { tone: 'success', text: t('providers.key.saved') }
              : { tone: 'success', text: t('providers.form.saved') },
        );
      }
    } catch (error) {
      fail(error);
    } finally {
      setSaving(false);
    }
  };

  const runVerify = async () => {
    if (!provider) return;
    setVerifying(true);
    setVerify(null);
    try {
      setVerify(await providersApi.verify(provider.id));
      void queryClient.invalidateQueries({ queryKey: providerKeys.all });
    } catch (error) {
      setProblem(describeError(error, t));
    } finally {
      setVerifying(false);
    }
  };

  const discover = async () => {
    if (!provider) return;
    setDiscovering(true);
    setProblem(null);
    try {
      const answer = await providersApi.discover(provider.id);
      refresh(answer.provider);
      toast.success(answer.added.length > 0 ? t.plural('providers.discover.added', answer.added.length, { found: t.number(answer.found) }) : t.plural('providers.discover.none', answer.found));
      if (answer.skipped > 0) toast.warning(t.plural('providers.discover.skipped', answer.skipped));
    } catch (error) {
      if (isApiError(error) && error.status === 409) setProblem(t('providers.discover.needsKey'));
      else setProblem(describeError(error, t));
    } finally {
      setDiscovering(false);
    }
  };

  const removeKey = async () => {
    if (!provider) return;
    if (!(await confirm({ title: t('providers.key.removeTitle'), message: t('providers.key.removeText'), confirmLabel: t('providers.key.remove'), tone: 'danger' }))) return;
    try {
      refresh(await providersApi.removeKey(provider.id));
      setNotice({ tone: 'success', text: t('providers.key.removed') });
    } catch (error) {
      fail(error);
    }
  };

  const removeProvider = async () => {
    if (!provider) return;
    if (!(await confirm({ title: t('providers.remove.title', { name: provider.name }), message: t('providers.remove.text'), confirmLabel: t('providers.remove.confirm'), tone: 'danger' }))) return;
    setRemoving(true);
    try {
      await providersApi.remove(provider.id);
      void queryClient.invalidateQueries({ queryKey: providerKeys.all });
      void queryClient.invalidateQueries({ queryKey: ['workbench', 'agents'] });
      toast.success(t('providers.remove.done', { name: provider.name }));
      onClose();
    } catch (error) {
      fail(error);
    } finally {
      setRemoving(false);
    }
  };

  const close = async () => {
    if (saving) return;
    if (dirty && !(await confirm({ title: t('providers.form.discardTitle'), message: t('providers.form.discardText'), confirmLabel: t('providers.form.discard'), tone: 'danger' }))) return;
    onClose();
  };

  const choosePreset = (id: string) => {
    const next = presets.find((entry) => entry.id === id) ?? null;
    setPreset(id);
    setDraft((current) => ({ ...draftFromPreset(next), key: current.key }));
  };

  const lastCheck = verify ?? provider?.settings?.lastCheck ?? null;

  return (
    <Sheet
      open={open}
      onClose={() => void close()}
      title={provider ? provider.name : t('providers.add.title')}
      size="lg"
      fill
      dismissible={!saving}
      footer={
        <>
          <Button variant="primary" block loading={saving} disabled={editing && !changes} onClick={() => void save()}>
            {editing ? t('providers.form.save') : t('providers.add.submit')}
          </Button>
          <Button variant="plain" block disabled={saving} onClick={() => void close()}>
            {editing ? t('common.done') : t('common.cancel')}
          </Button>
        </>
      }
    >
      <Form className="prv-form" onSubmit={() => void save()}>
        {notice && (
          <div key={notice.text} ref={reveal}>
            <Banner tone={notice.tone} role={notice.tone === 'warning' ? 'alert' : 'status'}>
              <p>{notice.text}</p>
            </Banner>
          </div>
        )}
        {problem && (
          <div key={problem} ref={reveal}>
            <Banner tone="danger" role="alert">
              <p>{problem}</p>
            </Banner>
          </div>
        )}

        {!editing && presets.length > 0 && (
          <Section title={t('providers.add.kind')} footer={t('providers.add.unverified')}>
            <div className="prv-presets" role="radiogroup" aria-label={t('providers.add.kind')}>
              {presets.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={preset === entry.id}
                  className="prv-preset"
                  // Choosing what to start from comes first; a text field taking the focus would bring up a phone's keyboard.
                  data-autofocus={preset === entry.id ? '' : undefined}
                  onClick={() => choosePreset(entry.id)}
                >
                  <span className="prv-preset__name">{entry.id === 'custom' ? t('providers.add.custom') : entry.name}</span>
                  <span className="prv-preset__text">{entry.id === 'custom' ? t('providers.add.customText') : entry.baseUrl}</span>
                </button>
              ))}
            </div>
            {presetInfo?.docsUrl && (
              <a className="prv-docs" href={presetInfo.docsUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={14} aria-hidden="true" />
                {t('providers.add.docs', { name: presetInfo.name })}
              </a>
            )}
          </Section>
        )}

        {editing && provider && (
          <Section title={t('providers.section.connection')}>
            <div className="prv-check" data-ok={lastCheck ? lastCheck.ok : undefined}>
              {verifying ? <Spinner size={18} /> : lastCheck ? lastCheck.ok ? <CircleCheck size={18} aria-hidden="true" /> : <CircleX size={18} aria-hidden="true" /> : <PlugZap size={18} aria-hidden="true" />}
              <div className="prv-check__text" aria-live="polite">
                <p>{lastCheck ? checkText(lastCheck, t) : t('providers.check.never')}</p>
                {lastCheck && (
                  <p className="prv-note">
                    {t('providers.check.when', { when: t.relative(lastCheck.checkedAt) })}
                    {verify?.modelCount != null ? ` · ${t.plural('providers.check.models', verify.modelCount)}` : ''}
                    {verify?.method === 'completion' ? ` · ${t('providers.check.byCompletion')}` : ''}
                  </p>
                )}
              </div>
              {/* Managing a provider usually starts here — and not in a text field, which would bring up a phone's keyboard. */}
              <Button size="sm" variant="tinted" loading={verifying} disabled={dirty} onClick={() => void runVerify()} data-autofocus="">
                {t('providers.check.run')}
              </Button>
            </div>
            {dirty && <p className="prv-note">{t('providers.check.saveFirst')}</p>}
          </Section>
        )}

        <Section title={t('providers.section.details')}>
          <TextField label={t('providers.field.name')} value={draft.name} onChange={(name) => set({ name })} maxLength={60} autoComplete="off" />
          {!editing && (
            <TextField label={t('providers.field.id')} value={draft.id} onChange={(id) => set({ id: id.toLowerCase() })} optional mono hint={t('providers.field.idHint')} maxLength={32} autoCapitalize="none" spellCheck={false} autoComplete="off" />
          )}
          <TextField
            label={t('providers.field.baseUrl')}
            value={draft.baseUrl}
            onChange={(baseUrl) => set({ baseUrl })}
            mono
            inputMode="url"
            placeholder="https://api.example.com/v1"
            hint={t('providers.field.baseUrlHint')}
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="off"
          />
          <div className="prv-switch-block">
            <div className="prv-switch-row">
              <span>{t('providers.field.private')}</span>
              <Switch checked={draft.allowPrivateNetwork} onChange={(allowPrivateNetwork) => set({ allowPrivateNetwork })} label={t('providers.field.private')} />
            </div>
            <p className="prv-note">{t('providers.field.privateText')}</p>
            {draft.allowPrivateNetwork && (
              <Banner tone="warning">
                <p>{t('providers.field.privateWarning')}</p>
              </Banner>
            )}
          </div>
        </Section>

        <Section title={t('providers.section.key')}>
          <p className="prv-key-state">
            <KeyRound size={15} aria-hidden="true" />
            {status === 'configured'
              ? t('providers.key.configured', { date: provider?.settings?.key.updatedAt ? t.date(provider.settings.key.updatedAt, 'date') : '—' })
              : status === 'unreadable'
                ? t('providers.key.unreadable')
                : status === 'not-needed'
                  ? t('providers.key.notNeeded')
                  : t('providers.key.missing')}
          </p>
          <KeyField
            value={draft.key}
            onChange={(key) => {
              set({ key });
              setKeyProblem(null);
            }}
            placeholder={t(keyPlaceholder(status))}
            error={keyProblem}
            hint={t('providers.key.hint')}
          />
          {warning === 'will-clear' && (
            <Banner tone="warning">
              <p>{t('providers.key.willClear')}</p>
            </Banner>
          )}
          {warning === 'will-replace' && <p className="prv-note">{t('providers.key.willReplace')}</p>}
          {editing && (status === 'configured' || status === 'unreadable') && (
            <Button size="sm" variant="plain-danger" icon={<Trash2 size={15} />} onClick={() => void removeKey()}>
              {t('providers.key.remove')}
            </Button>
          )}
        </Section>

        <Section title={t('providers.section.models')} footer={t('providers.catalogue.footer')}>
          {editing && (
            <div className="prv-discover">
              <Button size="sm" variant="neutral" icon={<Search size={15} />} loading={discovering} disabled={catalogueDirty || dirty} onClick={() => void discover()}>
                {t('providers.discover.run')}
              </Button>
              <p className="prv-note">
                {catalogueDirty || dirty
                  ? t('providers.discover.saveFirst')
                  : // The server offers what it finds while nothing is offered yet; after that, new ones arrive hidden.
                    draft.models.some((entry) => !entry.hidden)
                    ? t('providers.discover.text')
                    : t('providers.discover.textFirst')}
              </p>
            </div>
          )}
          <Catalogue models={draft.models} defaultModel={draft.defaultModel} onChange={(models, defaultModel) => set({ models, defaultModel })} />
        </Section>

        {editing && provider && (
          <Section title={t('providers.section.spend')} footer={t('providers.spend.footer')}>
            <ProviderSpend providerId={provider.id} isOwner balanceKind={provider.settings?.balance ?? 'none'} />
          </Section>
        )}

        <Section title={t('providers.section.availability')}>
          <div className="prv-switch-row">
            <span>{t('providers.field.enabled')}</span>
            <Switch checked={draft.enabled} onChange={(enabled) => set({ enabled })} label={t('providers.field.enabled')} />
          </div>
          <p className="prv-note">{draft.enabled ? t('providers.field.enabledOn') : t('providers.field.enabledOff')}</p>
          <details className="prv-advanced">
            <summary>{t('providers.section.advanced')}</summary>
            <div className="prv-switch-row">
              <span>{t('providers.field.keyRequired')}</span>
              <Switch checked={draft.keyRequired} onChange={(keyRequired) => set({ keyRequired })} label={t('providers.field.keyRequired')} />
            </div>
            <p className="prv-note">{t('providers.field.keyRequiredText')}</p>
            <div className="ui-field">
              <span className="ui-field__label">{t('providers.field.balance')}</span>
              <Select
                label={t('providers.field.balance')}
                value={draft.balance}
                onChange={(balance) => set({ balance })}
                block
                options={[
                  { value: 'none', label: t('providers.field.balanceNone'), hint: t('providers.field.balanceNoneHint') },
                  { value: 'deepseek', label: t('providers.field.balanceDeepseek'), hint: t('providers.field.balanceDeepseekHint') },
                ]}
              />
            </div>
          </details>
        </Section>

        {editing && provider && (
          <Section title={t('providers.section.remove')}>
            <p className="prv-note">{t('providers.remove.explain')}</p>
            <Button variant="plain-danger" icon={<ShieldAlert size={16} />} loading={removing} onClick={() => void removeProvider()}>
              {t('providers.remove.action', { name: provider.name })}
            </Button>
          </Section>
        )}
        {provider && (
          <p className="prv-note prv-meta">
            {t('providers.meta', { id: provider.id, host: hostOf(provider.settings?.baseUrl ?? '') })}
            {provider.settings?.preset ? ` · ${t('providers.metaPreset', { preset: provider.settings.preset })}` : ''}
            {!provider.enabled && (
              <>
                {' '}
                <Badge tone="neutral">{t('providers.status.off')}</Badge>
              </>
            )}
          </p>
        )}
        <button type="submit" hidden />
      </Form>
    </Sheet>
  );
}
