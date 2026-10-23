import {
  mailAccountsSchema,
  mailAccountSchema,
  mailFoldersSchema,
  mailListSchema,
  mailMessageSchema,
  mailDraftSchema,
  mailDraftsSchema,
  mailSummarySchema,
  mailLocalModelsSchema,
  type MailAccount,
  type MailDraft,
} from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/data/api';
import { describeError } from '@/data/errors';
import { useT } from '@/i18n';
import { useUnsavedWork } from '@/pwa/update';
import { Screen } from '@/shell/Screen';
import {
  Banner,
  Button,
  EmptyState,
  ErrorState,
  Form,
  IconButton,
  List,
  ListRow,
  LoadingRow,
  Select,
  Sheet,
  TextArea,
  TextField,
  confirm,
  toast,
} from '@/ui';
import { Markdown } from '@/ui/markdown';
import './mailbox.css';
const enc = encodeURIComponent;
const base = (id: string) => `/api/mailbox/accounts/${enc(id)}`;

function AccountForm({ account, close }: { account: MailAccount | null; close: () => void }) {
  const t = useT(),
    cache = useQueryClient();
  const [name, setName] = useState(''),
    [provider, setProvider] = useState<'gmail' | 'outlook'>('gmail');
  const [accessToken, setToken] = useState(''),
    [refreshToken, setRefresh] = useState(''),
    [clientId, setClientId] = useState(''),
    [clientSecret, setClientSecret] = useState(''),
    [busy, setBusy] = useState(false);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const credentials = {
        accessToken,
        ...(refreshToken ? { refreshToken } : {}),
        ...(clientId ? { clientId } : {}),
        ...(clientSecret ? { clientSecret } : {}),
      };
      if (account)
        await api.put(`${base(account.id)}/credentials`, credentials, {
          schema: mailAccountSchema,
        });
      else
        await api.post(
          '/api/mailbox/accounts',
          { name, provider, credentials },
          { schema: mailAccountSchema },
        );
      await cache.invalidateQueries({ queryKey: ['mailbox'] });
      close();
    } catch (e) {
      toast.error(describeError(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Form onSubmit={save}>
      <div className="mail-form">
        <p>{t('mail.credentialsHelp')}</p>
        {!account && (
          <>
            <TextField label={t('mail.name')} value={name} onChange={setName} />
            <Select
              label={t('mail.provider')}
              value={provider}
              onChange={setProvider}
              options={[
                { value: 'gmail', label: 'Gmail' },
                { value: 'outlook', label: 'Outlook' },
              ]}
            />
          </>
        )}
        <TextField
          type="password"
          secret
          label={t('mail.accessToken')}
          value={accessToken}
          onChange={setToken}
        />
        <TextField
          type="password"
          secret
          label={t('mail.refreshToken')}
          value={refreshToken}
          onChange={setRefresh}
        />
        <TextField label={t('mail.clientId')} value={clientId} onChange={setClientId} />
        <TextField
          type="password"
          secret
          label={t('mail.clientSecret')}
          value={clientSecret}
          onChange={setClientSecret}
        />
        <Button type="submit" loading={busy} disabled={!accessToken || (!account && !name)}>
          {t('mail.connect')}
        </Button>
      </div>
    </Form>
  );
}
function Compose({
  account,
  initial,
  close,
}: {
  account: MailAccount;
  initial: MailDraft | null;
  close: () => void;
}) {
  const t = useT(),
    cache = useQueryClient();
  const [saved, setSaved] = useState(initial),
    [to, setTo] = useState(initial?.to.join(', ') ?? ''),
    [subject, setSubject] = useState(initial?.subject ?? ''),
    [text, setText] = useState(initial?.text ?? ''),
    [busy, setBusy] = useState(false);
  const dirty =
    to !== (saved?.to.join(', ') ?? '') ||
    subject !== (saved?.subject ?? '') ||
    text !== (saved?.text ?? '');
  useUnsavedWork(dirty);
  const immutable = saved !== null && saved.status !== 'draft';
  const save = async (): Promise<MailDraft | null> => {
    const body = {
      to: to
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
      subject,
      text,
    };
    const item = saved
      ? await api.put(
          `${base(account.id)}/drafts/${enc(saved.id)}`,
          { ...body, revision: saved.revision },
          { schema: mailDraftSchema },
        )
      : await api.post(`${base(account.id)}/drafts`, body, { schema: mailDraftSchema });
    setSaved(item);
    await cache.invalidateQueries({ queryKey: ['mailbox', account.id, 'drafts'] });
    return item;
  };
  const action = async (send: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      const current = dirty || !saved ? await save() : saved;
      if (!current) return;
      if (!send) {
        toast.success(t('mail.saved'));
        return;
      }
      if (
        !(await confirm({
          title: t('mail.confirmSend'),
          message: t('mail.sendDetails', {
            account: account.name,
            recipients: current.to.join(', '),
            subject: current.subject,
          }),
          confirmLabel: t('mail.send'),
        }))
      )
        return;
      setSaved(
        await api.post(
          `${base(account.id)}/drafts/${enc(current.id)}/send`,
          { confirmed: true, revision: current.revision },
          { schema: mailDraftSchema, timeoutMs: 40000 },
        ),
      );
      toast.success(t('mail.sent'));
      close();
    } catch (e) {
      toast.error(describeError(e, t));
    } finally {
      setBusy(false);
      await cache.invalidateQueries({ queryKey: ['mailbox', account.id, 'drafts'] });
    }
  };
  return (
    <div className="mail-form">
      {saved && <Banner>{t(`mail.status.${saved.status}`)}</Banner>}
      <TextField label={t('mail.to')} value={to} onChange={setTo} disabled={immutable} />
      <TextField
        label={t('mail.subject')}
        value={subject}
        onChange={setSubject}
        disabled={immutable}
      />
      <TextArea
        label={t('mail.body')}
        value={text}
        onChange={setText}
        disabled={immutable}
        autoGrow
      />
      <div className="mail-actions">
        <Button disabled={immutable || busy || !to} onClick={() => void action(false)}>
          {t('mail.saveDraft')}
        </Button>
        <Button
          variant="primary"
          disabled={immutable || busy || !to}
          onClick={() => void action(true)}
        >
          {t('mail.send')}
        </Button>
        {saved && (
          <Button
            variant="plain-danger"
            disabled={busy || saved.status === 'sending'}
            onClick={() => {
              void (async () => {
                try {
                  await api.delete(`${base(account.id)}/drafts/${enc(saved.id)}`);
                  await cache.invalidateQueries({ queryKey: ['mailbox', account.id, 'drafts'] });
                  close();
                } catch (e) {
                  toast.error(describeError(e, t));
                }
              })();
            }}
          >
            {t('mail.deleteDraft')}
          </Button>
        )}
      </div>
    </div>
  );
}
function Message({ accountId, id, back }: { accountId: string; id: string; back: () => void }) {
  const t = useT();
  const message = useQuery({
    queryKey: ['mailbox', accountId, 'message', id],
    queryFn: ({ signal }) =>
      api.get(`${base(accountId)}/messages/${enc(id)}`, { schema: mailMessageSchema, signal }),
  });
  const models = useQuery({
    queryKey: ['mailbox', 'models'],
    queryFn: ({ signal }) =>
      api.get('/api/mailbox/local-models', { schema: mailLocalModelsSchema, signal }),
  });
  const options =
    models.data?.providers.flatMap((p) =>
      p.models.map((m) => ({
        value: JSON.stringify([p.id, m.id]),
        label: `${p.name} / ${m.name}`,
      })),
    ) ?? [];
  const [model, setModel] = useState(''),
    [summary, setSummary] = useState(''),
    [busy, setBusy] = useState(false);
  const selected = options.find((o) => o.value === model) ?? options[0];
  const summarize = async () => {
    if (
      !selected ||
      busy ||
      !(await confirm({
        title: t('mail.summaryConfirm'),
        message: t('mail.summaryConsent', { model: selected.label }),
        confirmLabel: t('mail.summarize'),
      }))
    )
      return;
    setBusy(true);
    try {
      const [providerId, model] = JSON.parse(selected.value) as [string, string];
      const result = await api.post(
        `${base(accountId)}/messages/${enc(id)}/summary`,
        { consent: true, providerId, model },
        { schema: mailSummarySchema, timeoutMs: 90000 },
      );
      setSummary(result.summary);
    } catch (e) {
      toast.error(describeError(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="mail-message">
      <Button onClick={back}>{t('mail.back')}</Button>
      {message.isError ? (
        <ErrorState error={message.error} onRetry={() => void message.refetch()} />
      ) : !message.data ? (
        <LoadingRow label={t('common.loading')} />
      ) : (
        <>
          <h2>{message.data.subject || t('mail.blankSubject')}</h2>
          <p>{message.data.from}</p>
          <p>{message.data.to}</p>
          <Banner>{t('mail.textOnly')}</Banner>
          <div className="mail-body">
            <Markdown>{message.data.text}</Markdown>
          </div>
          {message.data.attachments.length > 0 && (
            <section>
              <h3>{t('mail.attachments')}</h3>
              {message.data.attachments.map((a) => (
                <a
                  key={a.id}
                  className="mail-attachment"
                  download
                  href={`${base(accountId)}/messages/${enc(id)}/attachments/${enc(a.id)}`}
                >
                  {a.name} · {t.number(a.size)} B
                </a>
              ))}
            </section>
          )}
          <section className="mail-form">
            {models.isError ? (
              <ErrorState error={models.error} onRetry={() => void models.refetch()} />
            ) : selected ? (
              <>
                <Select
                  label={t('mail.localModel')}
                  value={selected.value}
                  onChange={setModel}
                  options={options}
                />
                <Button loading={busy} onClick={() => void summarize()}>
                  {t('mail.summarize')}
                </Button>
              </>
            ) : (
              <p>{t('mail.noLocalModel')}</p>
            )}
            {summary && (
              <>
                <h3>{t('mail.summary')}</h3>
                <Markdown>{summary}</Markdown>
              </>
            )}
          </section>
        </>
      )}
    </article>
  );
}
function AccountMailbox({ account, edit }: { account: MailAccount; edit: () => void }) {
  const t = useT(),
    cache = useQueryClient();
  const [folder, setFolder] = useState(''),
    [search, setSearch] = useState(''),
    [term, setTerm] = useState(''),
    [cursor, setCursor] = useState<string | undefined>(),
    [message, setMessage] = useState<string | null>(null),
    [compose, setCompose] = useState<{ initial: MailDraft | null } | null>(null);
  const folders = useQuery({
    queryKey: ['mailbox', account.id, 'folders'],
    queryFn: ({ signal }) =>
      api.get(`${base(account.id)}/folders`, { schema: mailFoldersSchema, signal }),
  });
  const list = useQuery({
    queryKey: ['mailbox', account.id, 'messages', folder, term, cursor],
    queryFn: ({ signal }) =>
      api.get(`${base(account.id)}/messages`, {
        schema: mailListSchema,
        query: { folder: folder || undefined, search: term, cursor },
        signal,
        timeoutMs: 90000,
      }),
    enabled: message === null,
  });
  const drafts = useQuery({
    queryKey: ['mailbox', account.id, 'drafts'],
    queryFn: ({ signal }) =>
      api.get(`${base(account.id)}/drafts`, { schema: mailDraftsSchema, signal }),
  });
  const remove = async () => {
    if (
      !(await confirm({
        title: t('mail.remove'),
        message: t('mail.removeConfirm'),
        confirmLabel: t('common.remove'),
        tone: 'danger',
      }))
    )
      return;
    try {
      await api.delete(base(account.id));
      await cache.invalidateQueries({ queryKey: ['mailbox'] });
    } catch (e) {
      toast.error(describeError(e, t));
    }
  };
  return (
    <>
      <div className="mail-actions">
        <Button onClick={() => setCompose({ initial: null })}>{t('mail.compose')}</Button>
        <Button variant="plain" onClick={edit}>
          {t('mail.replaceCredentials')}
        </Button>
        <Button variant="plain-danger" onClick={() => void remove()}>
          {t('mail.remove')}
        </Button>
      </div>
      {message ? (
        <Message key={message} accountId={account.id} id={message} back={() => setMessage(null)} />
      ) : (
        <>
          <Form
            onSubmit={() => {
              setTerm(search);
              setCursor(undefined);
            }}
          >
            <div className="mail-filters">
              <Select
                label={t('mail.folder')}
                value={folder}
                onChange={(value) => {
                  setFolder(value);
                  setCursor(undefined);
                }}
                options={[
                  { value: '', label: t('mail.all') },
                  ...(folders.data?.folders.map((f) => ({ value: f.id, label: f.name })) ?? []),
                ]}
              />
              <TextField label={t('mail.search')} value={search} onChange={setSearch} />
              <Button type="submit">{t('mail.search')}</Button>
            </div>
          </Form>
          {folders.isError && (
            <ErrorState error={folders.error} onRetry={() => void folders.refetch()} />
          )}
          {folders.data?.truncated && <Banner>{t('mail.folderLimit')}</Banner>}
          {list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : !list.data ? (
            <LoadingRow label={t('common.loading')} />
          ) : (
            <>
              <List>
                {list.data.messages.map((m) => (
                  <ListRow
                    key={m.id}
                    title={m.subject || t('mail.blankSubject')}
                    subtitle={`${m.from} · ${m.preview}`}
                    onPress={() => setMessage(m.id)}
                  />
                ))}
              </List>
              {list.data.messages.length === 0 && (
                <EmptyState icon={<Mail />} title={t('mail.empty')} />
              )}
              <div className="mail-actions">
                {cursor && <Button onClick={() => setCursor(undefined)}>{t('mail.first')}</Button>}
                {list.data.cursor && (
                  <Button onClick={() => setCursor(list.data!.cursor!)}>{t('mail.next')}</Button>
                )}
              </div>
            </>
          )}
          {drafts.isError ? (
            <ErrorState error={drafts.error} onRetry={() => void drafts.refetch()} />
          ) : (
            <List header={t('mail.drafts')}>
              {drafts.data?.drafts.map((d) => (
                <ListRow
                  key={d.id}
                  title={d.subject || t('mail.blankSubject')}
                  subtitle={t(`mail.status.${d.status}`)}
                  onPress={() => setCompose({ initial: d })}
                />
              ))}
            </List>
          )}
        </>
      )}
      {compose && (
        <Sheet open onClose={() => setCompose(null)} title={t('mail.compose')}>
          <Compose
            key={compose.initial?.id ?? 'new'}
            account={account}
            initial={compose.initial}
            close={() => setCompose(null)}
          />
        </Sheet>
      )}
    </>
  );
}
export default function MailboxScreen() {
  const t = useT();
  const accounts = useQuery({
    queryKey: ['mailbox', 'accounts'],
    queryFn: ({ signal }) =>
      api.get('/api/mailbox/accounts', { schema: mailAccountsSchema, signal }),
  });
  const [selected, setSelected] = useState(''),
    [form, setForm] = useState<{ account: MailAccount | null } | null>(null);
  const account =
    accounts.data?.accounts.find((a) => a.id === selected) ?? accounts.data?.accounts[0];
  return (
    <Screen
      title={t('mail.title')}
      width="wide"
      actions={
        <IconButton
          label={t('common.retry')}
          icon={<RefreshCw />}
          onClick={() => void accounts.refetch()}
        />
      }
    >
      <div className="mail-page">
        <div className="mail-actions">
          <Button icon={<Plus />} onClick={() => setForm({ account: null })}>
            {t('mail.add')}
          </Button>
          {account && (
            <Select
              label={t('mail.account')}
              value={account.id}
              onChange={setSelected}
              options={accounts.data!.accounts.map((a) => ({ value: a.id, label: a.name }))}
            />
          )}
        </div>
        {accounts.isError ? (
          <ErrorState error={accounts.error} onRetry={() => void accounts.refetch()} />
        ) : !accounts.data ? (
          <LoadingRow label={t('common.loading')} />
        ) : account ? (
          <AccountMailbox key={account.id} account={account} edit={() => setForm({ account })} />
        ) : (
          <EmptyState
            icon={<Mail />}
            title={t('mail.noAccounts')}
            description={t('mail.accountsHelp')}
          />
        )}
        {form && (
          <Sheet
            open
            title={t(form.account ? 'mail.replaceCredentials' : 'mail.add')}
            onClose={() => setForm(null)}
          >
            <AccountForm account={form.account} close={() => setForm(null)} />
          </Sheet>
        )}
      </div>
    </Screen>
  );
}
