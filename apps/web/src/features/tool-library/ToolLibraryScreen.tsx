import {
  libraryInputSchema,
  libraryItemSchema,
  libraryListSchema,
  libraryToolsSchema,
  type LibraryItem,
} from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Wrench } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/data/api';
import { useProjects } from '@/data/projects';
import { useUser } from '@/data/session';
import { useT } from '@/i18n';
import { useUnsavedWork } from '@/pwa/update';
import { Screen } from '@/shell/Screen';
import {
  Button,
  EmptyState,
  ErrorState,
  Form,
  LoadingRow,
  Select,
  Sheet,
  TextArea,
  TextField,
  confirm,
} from '@/ui';
import './library.css';

function Editor({
  item,
  projectId,
  close,
}: {
  item: LibraryItem | null;
  projectId: string | null;
  close: () => void;
}) {
  const t = useT(),
    cache = useQueryClient(),
    user = useUser();
  const [form, setForm] = useState(() =>
    libraryInputSchema.parse(
      item
        ? {
            kind: item.kind,
            name: item.name,
            description: item.description,
            content: item.content,
            endpoint: item.endpoint,
            allowPrivateNetwork: item.allowPrivateNetwork,
            projectId: item.projectId,
            enabled: item.enabled,
          }
        : { kind: 'skill', name: 'new-entry', projectId },
    ),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>(null),
    [dirty, setDirty] = useState(false);
  useUnsavedWork(dirty);
  const update = (patch: Partial<typeof form>) => {
    setForm({ ...form, ...patch });
    setDirty(true);
  };
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = libraryInputSchema.parse(form);
      if (item)
        await api.put(
          `/api/tool-library/${item.id}`,
          { ...body, version: item.version },
          { schema: libraryItemSchema },
        );
      else await api.post('/api/tool-library', body, { schema: libraryItemSchema });
      await cache.invalidateQueries({ queryKey: ['tool-library'] });
      setDirty(false);
      close();
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Form onSubmit={save}>
      <div className="library-form">
        {!item && (
          <Select
            label={t('library.kind')}
            value={form.kind}
            onChange={(kind) =>
              update({ kind, content: '', endpoint: '', token: '', allowPrivateNetwork: false })
            }
            options={(['skill', 'command', 'mcp'] as const).map((value) => ({
              value,
              label: t(`library.${value}`),
            }))}
          />
        )}
        <TextField
          label={t('library.name')}
          value={form.name}
          onChange={(name) => update({ name })}
          maxLength={40}
        />
        <TextField
          label={t('library.description')}
          value={form.description}
          onChange={(description) => update({ description })}
          maxLength={400}
        />
        {form.kind === 'mcp' ? (
          <>
            <p>{t('library.mcpHint')}</p>
            <TextField
              label={t('library.endpoint')}
              value={form.endpoint}
              onChange={(endpoint) => update({ endpoint })}
              type="url"
              autoComplete="off"
            />
            <TextField
              label={t('library.token')}
              value={form.token ?? ''}
              onChange={(token) => update({ token })}
              type="password"
              secret
            />
            {item?.credentialSaved && (
              <label className="library-check">
                <input
                  type="checkbox"
                  checked={form.clearToken}
                  onChange={(event) => update({ clearToken: event.target.checked })}
                />
                {t('library.clearToken')}
              </label>
            )}
            {user?.role === 'owner' && (
              <label className="library-check">
                <input
                  type="checkbox"
                  checked={form.allowPrivateNetwork}
                  onChange={(event) => update({ allowPrivateNetwork: event.target.checked })}
                />
                {t('library.private')}
              </label>
            )}
          </>
        ) : (
          <TextArea
            label={t('library.content')}
            hint={t('library.templateHint')}
            value={form.content}
            onChange={(content) => update({ content })}
            rows={12}
            maxLength={32000}
          />
        )}
        <label className="library-check">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          {t('library.enabled')}
        </label>
        {error !== null && <ErrorState error={error} compact />}
        <Button
          type="submit"
          loading={busy}
          disabled={!form.name || (form.kind !== 'mcp' && !form.content.trim())}
        >
          {t('library.save')}
        </Button>
      </div>
    </Form>
  );
}

export default function ToolLibraryScreen() {
  const t = useT(),
    projects = useProjects(),
    cache = useQueryClient();
  const [scope, setScope] = useState(''),
    [editing, setEditing] = useState<LibraryItem | null | undefined>(),
    [error, setError] = useState<unknown>(null),
    [busy, setBusy] = useState<string | null>(null),
    [tools, setTools] = useState<Awaited<ReturnType<typeof libraryToolsSchema.parse>> | null>(null);
  const query = useQuery({
    queryKey: ['tool-library', scope],
    queryFn: () =>
      api.get('/api/tool-library', {
        schema: libraryListSchema,
        query: scope ? { projectId: scope } : {},
      }),
  });
  async function remove(item: LibraryItem) {
    if (
      !(await confirm({
        title: t('library.deleteTitle'),
        message: t('library.deleteBody'),
        confirmLabel: t('library.delete'),
        tone: 'danger',
      }))
    )
      return;
    setBusy(item.id);
    try {
      await api.delete(`/api/tool-library/${item.id}`, { body: { version: item.version } });
      await cache.invalidateQueries({ queryKey: ['tool-library'] });
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  }
  async function test(item: LibraryItem) {
    setBusy(item.id);
    setError(null);
    try {
      setTools(
        await api.post(
          `/api/tool-library/${item.id}/test`,
          { version: item.version },
          { schema: libraryToolsSchema, timeoutMs: 40000 },
        ),
      );
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(null);
    }
  }
  return (
    <Screen
      title={t('library.title')}
      caption={t('library.caption')}
      actions={
        <Button variant="plain" icon={<Plus size={18} />} onClick={() => setEditing(null)}>
          {t('library.new')}
        </Button>
      }
    >
      <div className="library-page">
        <Select
          label={t('library.scope')}
          value={scope}
          onChange={setScope}
          options={[
            { value: '', label: t('library.global') },
            ...(projects.data ?? []).map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        {error !== null && <ErrorState error={error} />}{' '}
        {query.isPending ? (
          <LoadingRow label={t('common.loading')} />
        ) : query.error ? (
          <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        ) : query.data?.items.length === 0 ? (
          <EmptyState
            icon={<Wrench />}
            title={t('library.empty')}
            description={t('library.emptyHint')}
          />
        ) : (
          query.data?.items.map((item) => (
            <article className="library-card" key={item.id}>
              <div>
                <strong>{item.name}</strong>
                <p>
                  {t(`library.${item.kind}`)} · {t('library.version', { version: item.version })} ·{' '}
                  {item.projectId
                    ? (projects.data?.find((p) => p.id === item.projectId)?.name ?? '')
                    : t('library.global')}
                </p>
                <p>{item.description}</p>
                {item.kind !== 'mcp' && (
                  <code>
                    /{item.kind === 'skill' ? 'skill:' : ''}
                    {item.name}
                  </code>
                )}
              </div>
              <div className="library-actions">
                <Button variant="neutral" disabled={busy !== null} onClick={() => setEditing(item)}>
                  {t('library.edit')}
                </Button>
                {item.kind === 'mcp' && (
                  <Button
                    variant="neutral"
                    disabled={!item.enabled || busy !== null}
                    onClick={() => void test(item)}
                  >
                    {t('library.test')}
                  </Button>
                )}
                <Button variant="plain" disabled={busy !== null} onClick={() => void remove(item)}>
                  {t('library.delete')}
                </Button>
              </div>
            </article>
          ))
        )}
      </div>
      <Sheet
        open={editing !== undefined}
        onClose={() => setEditing(undefined)}
        title={t(editing ? 'library.edit' : 'library.new')}
      >
        {editing !== undefined && (
          <Editor
            key={editing?.id ?? `new:${scope}`}
            item={editing}
            projectId={scope || null}
            close={() => setEditing(undefined)}
          />
        )}
      </Sheet>
      <Sheet open={tools !== null} onClose={() => setTools(null)} title={t('library.tools')}>
        <div className="library-form">
          {tools?.tools.map((tool) => (
            <article key={tool.name}>
              <strong>{tool.name}</strong>
              <p>{tool.description}</p>
            </article>
          ))}
        </div>
      </Sheet>
    </Screen>
  );
}
