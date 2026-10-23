import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, History, Pencil } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { describeError } from '@/data/errors';
import { useUser } from '@/data/session';
import { useT } from '@/i18n';
import { Button, ErrorState, Sheet, TextArea, confirm, toast } from '@/ui';
import { newRequestId } from '../composer/delivery';
import { workbenchPaths } from '../routes';
import { conversationApi } from './features-api';
import { upsertSession, useSessionQuery } from './queries';
import './conversations.css';

export function MessageBranchActions({
  sessionId,
  seq,
  text,
  role,
}: {
  sessionId: string;
  seq: number;
  text: string;
  role: 'user' | 'assistant';
}) {
  const t = useT();
  const user = useUser();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const session = useSessionQuery(sessionId);
  const [editing, setEditing] = useState(false);
  const [replacement, setReplacement] = useState(text);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const checkpoints = useQuery({
    queryKey: ['message-checkpoints', sessionId, seq],
    queryFn: () => conversationApi.checkpoints(sessionId, seq),
    enabled: preview,
  });
  const mine = session.data?.userId === user?.id;
  const disabled = busy || session.data?.activeRunId !== null;
  const fork = async (edit: boolean) => {
    if (
      !edit &&
      !(await confirm({
        title: t('conversations.forkHere'),
        message: t('conversations.branchHint'),
        confirmLabel: t('conversations.fork'),
      }))
    )
      return;
    setBusy(true);
    try {
      const branch = await conversationApi.fork(sessionId, {
        throughSeq: seq,
        ...(edit ? { replacement: { text: replacement, requestId: newRequestId() } } : {}),
      });
      upsertSession(queryClient, branch);
      setEditing(false);
      void navigate(workbenchPaths.session(branch.projectId, branch.id));
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setBusy(false);
    }
  };
  const restore = async (id: string, path: string, version: string) => {
    if (
      !(await confirm({
        title: t('conversations.restoreTitle', { path }),
        message: t('conversations.restoreHint'),
        confirmLabel: t('conversations.restore'),
        tone: 'danger',
      }))
    )
      return;
    setBusy(true);
    try {
      await conversationApi.restore(sessionId, id, version);
      toast.success(t('conversations.restored'));
      await checkpoints.refetch();
    } catch (error) {
      toast.error(describeError(error, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <span className="conversation-actions">
        {mine && (
          <Button
            size="sm"
            variant="plain"
            disabled={disabled}
            onClick={() => void fork(false)}
            icon={<GitBranch size={16} />}
          >
            {t('conversations.forkHere')}
          </Button>
        )}
        {mine && role === 'user' && (
          <Button
            size="sm"
            variant="plain"
            disabled={disabled}
            onClick={() => {
              setReplacement(text);
              setEditing(true);
            }}
            icon={<Pencil size={16} />}
          >
            {t('conversations.edit')}
          </Button>
        )}
        {session.data?.projectId && (
          <Button
            size="sm"
            variant="plain"
            onClick={() => setPreview(true)}
            icon={<History size={16} />}
          >
            {t('conversations.checkpoints')}
          </Button>
        )}
      </span>
      <Sheet open={editing} onClose={() => setEditing(false)} title={t('conversations.edit')}>
        <div className="conversation-panel">
          <p>{t('conversations.editHint')}</p>
          <TextArea
            label={t('conversations.message')}
            value={replacement}
            onChange={setReplacement}
            maxLength={100000}
            rows={8}
          />
          <Button disabled={disabled || !replacement.trim()} onClick={() => void fork(true)}>
            {t('conversations.sendBranch')}
          </Button>
        </div>
      </Sheet>
      <Sheet
        open={preview}
        onClose={() => setPreview(false)}
        title={t('conversations.checkpoints')}
        size="lg"
      >
        <div className="conversation-panel">
          <p className="conversation-help">{t('conversations.checkpointScope')}</p>
          {checkpoints.isError && (
            <ErrorState error={checkpoints.error} onRetry={() => void checkpoints.refetch()} />
          )}
          {checkpoints.isPending && <p>{t('common.loading')}</p>}
          {checkpoints.data?.files.length === 0 && <p>{t('conversations.noCheckpoints')}</p>}
          {checkpoints.data?.files.map((file) => (
            <section className="conversation-checkpoint" key={file.id}>
              <strong>{file.path}</strong>
              <details>
                <summary>{t('conversations.before')}</summary>
                <pre>{file.before}</pre>
              </details>
              <details>
                <summary>{t('conversations.current')}</summary>
                <pre>{file.current ?? t('conversations.restoreUnavailable')}</pre>
              </details>
              <Button
                variant="neutral"
                disabled={
                  !mine ||
                  disabled ||
                  !file.available ||
                  file.currentVersion === null ||
                  file.before === file.current
                }
                onClick={() => {
                  if (file.currentVersion) void restore(file.id, file.path, file.currentVersion);
                }}
              >
                {t('conversations.restore')}
              </Button>
            </section>
          ))}
        </div>
      </Sheet>
    </>
  );
}
