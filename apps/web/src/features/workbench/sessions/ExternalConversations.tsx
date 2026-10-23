import {
  externalConversationRootSchema,
  externalConversationRootsSchema,
  externalConversationsSchema,
  sessionSchema,
  type ExternalConversation,
} from '@agent-studio/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FolderPlus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '@/data/api';
import { describeError } from '@/data/errors';
import { useIsOwner } from '@/data/session';
import { useT } from '@/i18n';
import { Button, ErrorState, List, ListRow, Sheet, TextField, confirm, toast } from '@/ui';
import { workbenchPaths } from '../routes';
import { upsertSession } from './queries';
import './conversations.css';

const keys = {
  roots: ['external-conversation-roots'] as const,
  sources: (id: string) => ['external-conversations', id] as const,
};
const externalApi = {
  roots: () =>
    api.get('/api/external-conversation-roots', { schema: externalConversationRootsSchema }),
  create: (name: string, directory: string, agentId: 'claude-code' | 'codex') =>
    api.post(
      '/api/external-conversation-roots',
      { name, directory, agentId },
      { schema: externalConversationRootSchema },
    ),
  remove: (id: string) => api.delete(`/api/external-conversation-roots/${encodeURIComponent(id)}`),
  discover: (id: string) =>
    api.get(`/api/external-conversation-roots/${encodeURIComponent(id)}/conversations`, {
      schema: externalConversationsSchema,
    }),
  import: (entry: ExternalConversation, projectId: string) =>
    api.post(
      `/api/external-conversation-roots/${encodeURIComponent(entry.rootId)}/import`,
      { sourceId: entry.id, version: entry.version, projectId },
      { schema: sessionSchema, timeoutMs: 60_000 },
    ),
};

export function ExternalConversations({ projectId }: { projectId: string | null }) {
  const t = useT();
  const owner = useIsOwner();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [rootId, setRootId] = useState('');
  const [name, setName] = useState('');
  const [directory, setDirectory] = useState('');
  const [agentId, setAgentId] = useState<'claude-code' | 'codex'>('claude-code');
  const [busy, setBusy] = useState(false);
  const roots = useQuery({
    queryKey: keys.roots,
    queryFn: externalApi.roots,
    enabled: owner && open,
  });
  const sources = useQuery({
    queryKey: keys.sources(rootId),
    queryFn: () => externalApi.discover(rootId),
    enabled: owner && open && rootId !== '',
  });
  if (!owner) return null;
  const create = async () => {
    setBusy(true);
    try {
      const root = await externalApi.create(name, directory, agentId);
      setName('');
      setDirectory('');
      await roots.refetch();
      setRootId(root.id);
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !rootId ||
      !(await confirm({
        title: t('external.removeRoot'),
        message: t('external.removeHint'),
        confirmLabel: t('external.removeRoot'),
      }))
    )
      return;
    try {
      await externalApi.remove(rootId);
      setRootId('');
      await roots.refetch();
    } catch (error) {
      toast.error(describeError(error, t));
    }
  };
  const importConversation = async (entry: ExternalConversation) => {
    if (
      !projectId ||
      !(await confirm({
        title: t('external.import'),
        message: t('external.importHint'),
        confirmLabel: t('external.import'),
      }))
    )
      return;
    setBusy(true);
    try {
      const session = await externalApi.import(entry, projectId);
      upsertSession(queryClient, session);
      setOpen(false);
      void navigate(workbenchPaths.session(projectId, session.id));
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" variant="plain" icon={<Download size={16} />} onClick={() => setOpen(true)}>
        {t('external.title')}
      </Button>
      <Sheet open={open} onClose={() => setOpen(false)} title={t('external.title')} size="lg">
        <div className="conversation-panel">
          <p className="conversation-help">{t('external.intro')}</p>
          {roots.isError && <ErrorState error={roots.error} onRetry={() => void roots.refetch()} />}
          <label>
            {t('external.source')}
            <select
              className="conversation-select"
              value={rootId}
              onChange={(event) => setRootId(event.target.value)}
            >
              <option value="">{t('external.choose')}</option>
              {roots.data?.roots.map((root) => (
                <option key={root.id} value={root.id}>
                  {root.name}
                </option>
              ))}
            </select>
          </label>
          {rootId && (
            <div className="conversation-actions">
              <Button
                variant="neutral"
                onClick={() => void sources.refetch()}
                disabled={sources.isFetching}
              >
                {t('external.refresh')}
              </Button>
              <Button variant="plain" onClick={() => void remove()}>
                {t('external.removeRoot')}
              </Button>
            </div>
          )}
          {!projectId && <p>{t('external.chooseProject')}</p>}
          {sources.isError && rootId && (
            <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
          )}
          {sources.isFetching && <p>{t('common.loading')}</p>}
          {sources.data?.limited && <p className="conversation-help">{t('external.limited')}</p>}
          {sources.data?.conversations.length === 0 && <p>{t('external.empty')}</p>}
          <List>
            {sources.data?.conversations.map((entry) => (
              <ListRow
                key={entry.id}
                title={entry.title}
                subtitle={`${entry.agentId === 'codex' ? 'Codex' : 'Claude Code'} · ${t.date(entry.modifiedAt, 'dateTime')}`}
                trailing={
                  <Button
                    size="sm"
                    variant="neutral"
                    disabled={busy || !projectId}
                    onClick={() => void importConversation(entry)}
                  >
                    {t('external.import')}
                  </Button>
                }
              />
            ))}
          </List>
          <details>
            <summary>{t('external.addRoot')}</summary>
            <div className="conversation-panel">
              <TextField
                label={t('external.name')}
                value={name}
                onChange={setName}
                maxLength={80}
              />
              <TextField
                label={t('external.directory')}
                value={directory}
                onChange={setDirectory}
                maxLength={4096}
                mono
              />
              <label>
                {t('profiles.provider')}
                <select
                  className="conversation-select"
                  value={agentId}
                  onChange={(event) => setAgentId(event.target.value as 'claude-code' | 'codex')}
                >
                  <option value="claude-code">Claude Code</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
              <Button
                disabled={busy || !name.trim() || !directory.trim()}
                icon={<FolderPlus size={16} />}
                onClick={() => void create()}
              >
                {t('external.addRoot')}
              </Button>
            </div>
          </details>
        </div>
      </Sheet>
    </>
  );
}
