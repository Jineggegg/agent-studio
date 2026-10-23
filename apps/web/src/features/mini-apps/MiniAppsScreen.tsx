import {
  miniAppListSchema,
  miniAppSchema,
  miniAppPreviewSchema,
  miniAppProposalsSchema,
  type MiniApp,
} from '@agent-studio/protocol';
import { useQuery } from '@tanstack/react-query';
import { AppWindow, Plus } from 'lucide-react';
import { useState } from 'react';
import { useParams } from 'react-router';
import { api } from '@/data/api';
import { describeError } from '@/data/errors';
import { useT } from '@/i18n';
import { Screen } from '@/shell/Screen';
import {
  Banner,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Form,
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
import './mini-apps.css';
const enc = encodeURIComponent;
const command = (app: Pick<MiniApp, 'build'>) =>
  app.build.kind === 'none'
    ? ''
    : JSON.stringify(
        app.build.kind === 'npm'
          ? ['npm', 'run', app.build.script, '--', ...app.build.args]
          : ['node', app.build.script, ...app.build.args],
      );
const escape = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
function AppForm({
  projectId,
  initial,
  done,
}: {
  projectId: string;
  initial: MiniApp | null;
  done: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(initial?.name ?? ''),
    [directory, setDirectory] = useState(initial?.directory ?? 'apps/my-app'),
    [output, setOutput] = useState(initial?.outputDirectory ?? '.'),
    [kind, setKind] = useState<'none' | 'npm' | 'node'>(initial?.build.kind ?? 'none'),
    [script, setScript] = useState(
      initial?.build.kind !== 'none' ? (initial?.build.script ?? 'build') : 'build',
    ),
    [args, setArgs] = useState(
      initial?.build.kind !== 'none' ? (initial?.build.args.join('\n') ?? '') : '',
    ),
    [scaffold, setScaffold] = useState(false),
    [busy, setBusy] = useState(false);
  const [html, setHtml] = useState(
    `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(t('apps.starterTitle'))}</title><style>body{font-family:system-ui;margin:2rem}button{min-height:44px;padding:0 1rem;font:inherit}</style></head><body><h1>${escape(t('apps.starterTitle'))}</h1><p>${escape(t('apps.starterText'))}</p><button id="count">${escape(t('apps.starterButton'))}: 0</button><script>let count=0;const button=document.getElementById('count');button.addEventListener('click',()=>{button.textContent=String(++count)});</script></body></html>`,
  );
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const build =
        kind === 'none'
          ? { kind }
          : { kind, script, args: args.split('\n').filter((a) => a !== '') };
      const body = { name, directory, outputDirectory: output, build };
      const url = `/api/projects/${enc(projectId)}/mini-apps`;
      if (initial) await api.put(`${url}/${enc(initial.id)}`, body, { schema: miniAppSchema });
      else
        await api.post(url, { ...body, ...(scaffold ? { html } : {}) }, { schema: miniAppSchema });
      done();
    } catch (e) {
      toast.error(describeError(e, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Form onSubmit={save}>
      <div className="apps-form">
        <TextField label={t('apps.name')} value={name} onChange={setName} />
        <TextField label={t('apps.directory')} value={directory} onChange={setDirectory} />
        <TextField label={t('apps.output')} value={output} onChange={setOutput} />
        <Select
          label={t('apps.buildKind')}
          value={kind}
          onChange={setKind}
          options={[
            { value: 'none', label: t('apps.none') },
            { value: 'npm', label: t('apps.npm') },
            { value: 'node', label: t('apps.node') },
          ]}
        />
        {kind !== 'none' && (
          <>
            <TextField label={t('apps.script')} value={script} onChange={setScript} />
            <TextArea label={t('apps.args')} value={args} onChange={setArgs} />
          </>
        )}
        {!initial && (
          <Checkbox checked={scaffold} onChange={setScaffold} label={t('apps.scaffold')} />
        )}
        {!initial && scaffold && (
          <TextArea label={t('apps.html')} value={html} onChange={setHtml} autoGrow maxRows={12} />
        )}
        <Button type="submit" loading={busy} disabled={!name || !directory || !output}>
          {t('common.save')}
        </Button>
      </div>
    </Form>
  );
}
export default function MiniAppsScreen() {
  const t = useT(),
    { projectId = '' } = useParams();
  const base = `/api/projects/${enc(projectId)}/mini-apps`,
    proposalsPath = `/api/projects/${enc(projectId)}/mini-app-proposals`;
  const list = useQuery({
    queryKey: ['mini-apps', projectId],
    queryFn: ({ signal }) => api.get(base, { schema: miniAppListSchema, signal }),
    refetchInterval: 2000,
  });
  const proposals = useQuery({
    queryKey: ['mini-app-proposals', projectId],
    queryFn: ({ signal }) => api.get(proposalsPath, { schema: miniAppProposalsSchema, signal }),
    refetchInterval: 10000,
  });
  const [form, setForm] = useState<{ initial: MiniApp | null } | null>(null),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState<{
      appId: string;
      name: string;
      url: string;
      expiresAt: number;
    } | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      await list.refetch();
      await proposals.refetch();
    } catch (e) {
      toast.error(describeError(e, t));
    } finally {
      setBusy(false);
    }
  };
  const start = (app: MiniApp) =>
    run(async () => {
      const isStatic = app.build.kind === 'none';
      if (
        !(await confirm({
          title: t(isStatic ? 'apps.confirmPublish' : 'apps.confirmBuild'),
          message: isStatic
            ? t('apps.confirmPublishText', { directory: `${app.directory}/${app.outputDirectory}` })
            : t('apps.confirmBuildText', {
                directory: app.directory,
                output: app.outputDirectory,
                command: command(app),
              }),
          confirmLabel: t(isStatic ? 'apps.publish' : 'apps.build'),
        }))
      )
        return;
      await api.post(
        `${base}/${enc(app.id)}/build`,
        { confirmed: true, configRevision: app.configRevision },
        { schema: miniAppSchema },
      );
    });
  const open = (app: { id: string; name: string }) =>
    run(async () => {
      const grant = await api.post(
        `${base}/${enc(app.id)}/preview`,
        {},
        { schema: miniAppPreviewSchema },
      );
      setPreview({ ...grant, appId: app.id, name: app.name });
    });
  return (
    <Screen
      title={t('apps.title')}
      width="wide"
      actions={
        list.data?.canWrite ? (
          <Button icon={<Plus />} onClick={() => setForm({ initial: null })}>
            {t('apps.add')}
          </Button>
        ) : undefined
      }
    >
      <div className="apps-page">
        <Banner>{t('apps.help')}</Banner>
        {list.data && !list.data.buildAvailable && (
          <Banner tone="warning">{t('apps.sandbox')}</Banner>
        )}
        {list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.data ? (
          <LoadingRow label={t('common.loading')} />
        ) : list.data.apps.length === 0 ? (
          <EmptyState icon={<AppWindow />} title={t('apps.empty')} />
        ) : (
          list.data.apps.map((app) => (
            <article key={app.id} className="apps-card">
              <h2>{app.name}</h2>
              <p>
                {t(`apps.state.${app.state}`)} · {app.directory} → {app.outputDirectory}
              </p>
              {command(app) && <code>{command(app)}</code>}
              <div className="apps-actions">
                {list.data?.canWrite && (
                  <>
                    <Button
                      disabled={
                        busy ||
                        app.state === 'building' ||
                        (app.build.kind !== 'none' && !list.data.buildAvailable)
                      }
                      onClick={() => void start(app)}
                    >
                      {t(app.build.kind === 'none' ? 'apps.publish' : 'apps.build')}
                    </Button>
                    {app.state === 'building' ? (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            api.post(`${base}/${enc(app.id)}/cancel`, { confirmed: true }),
                          )
                        }
                      >
                        {t('apps.cancel')}
                      </Button>
                    ) : (
                      <>
                        <Button onClick={() => setForm({ initial: app })}>{t('apps.edit')}</Button>
                        <Button
                          variant="plain-danger"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              if (
                                await confirm({
                                  title: t('apps.remove'),
                                  message: t('apps.confirmRemove'),
                                  confirmLabel: t('common.remove'),
                                  tone: 'danger',
                                })
                              )
                                await api.delete(`${base}/${enc(app.id)}`);
                            })
                          }
                        >
                          {t('apps.remove')}
                        </Button>
                      </>
                    )}
                  </>
                )}
                <Button disabled={busy || app.state !== 'ready'} onClick={() => void open(app)}>
                  {t('apps.preview')}
                </Button>
              </div>
              <details>
                <summary>{t('apps.logs')}</summary>
                <pre className="apps-log">{app.log || t('apps.noLogs')}</pre>
              </details>
            </article>
          ))
        )}
        <Banner>{t('apps.proposalHelp')}</Banner>
        {proposals.isError && (
          <ErrorState error={proposals.error} onRetry={() => void proposals.refetch()} />
        )}
        {Boolean(proposals.data?.proposals.length) && (
          <List header={t('apps.pending')}>
            {proposals.data?.proposals.map((p) => {
              const title =
                p.proposal.operation === 'create'
                  ? t('apps.proposalCreate', { name: p.proposal.app.name })
                  : t('apps.proposalBuild', { id: p.proposal.appId });
              const review =
                p.proposal.operation === 'build'
                  ? p.proposal.config.build.kind === 'none'
                    ? t('apps.confirmPublishText', {
                        directory: `${p.proposal.config.directory}/${p.proposal.config.outputDirectory}`,
                      })
                    : t('apps.confirmBuildText', {
                        directory: p.proposal.config.directory,
                        output: p.proposal.config.outputDirectory,
                        command: command(p.proposal.config),
                      })
                  : JSON.stringify(p.proposal, null, 2);
              return (
                <ListRow
                  key={p.id}
                  title={title}
                  subtitle={
                    <details>
                      <summary>{t('apps.reviewConfiguration')}</summary>
                      <p>{review}</p>
                      <pre className="apps-log">{JSON.stringify(p.proposal, null, 2)}</pre>
                    </details>
                  }
                  trailing={
                    <div className="apps-actions">
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            if (
                              await confirm({
                                title: t('apps.proposalConfirm'),
                                message: review,
                                confirmLabel: t('apps.approve'),
                              })
                            )
                              await api.post(
                                `${proposalsPath}/${enc(p.id)}/approve`,
                                { confirmed: true },
                                { schema: miniAppSchema },
                              );
                          })
                        }
                      >
                        {t('apps.approve')}
                      </Button>
                      <Button
                        variant="plain"
                        disabled={busy}
                        onClick={() => void run(() => api.delete(`${proposalsPath}/${enc(p.id)}`))}
                      >
                        {t('apps.dismiss')}
                      </Button>
                    </div>
                  }
                />
              );
            })}
          </List>
        )}
        {form && (
          <Sheet
            open
            title={t(form.initial ? 'apps.edit' : 'apps.add')}
            onClose={() => setForm(null)}
          >
            <AppForm
              projectId={projectId}
              initial={form.initial}
              done={() => {
                setForm(null);
                void list.refetch();
              }}
            />
          </Sheet>
        )}
        {preview && (
          <Sheet open fill title={preview.name} onClose={() => setPreview(null)}>
            <div className="apps-preview">
              <p>{t('apps.previewExpires', { time: t.date(preview.expiresAt, 'time') })}</p>
              <Button
                disabled={busy}
                onClick={() => void open({ id: preview.appId, name: preview.name })}
              >
                {t('apps.refreshPreview')}
              </Button>
              <iframe
                key={preview.url}
                title={preview.name}
                src={preview.url}
                sandbox="allow-scripts"
                referrerPolicy="no-referrer"
              />
            </div>
          </Sheet>
        )}
      </div>
    </Screen>
  );
}
